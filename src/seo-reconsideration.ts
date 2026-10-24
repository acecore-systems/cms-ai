import type { AppEnv } from "./env.ts";
import { sha256 } from "./seo-hash.ts";
import { seoWorkflowCompleted } from "./github.ts";
import { getSiteById } from "./sites.ts";
// Read-only service proof. Never replays an old job, model call or callback.
export async function reconsiderationProof(env: AppEnv, input: unknown) {
  const denied = { status: "denied" as const };
  try {
    const v = input as any;
    if (
      !v ||
      Object.keys(v).some(
        (k) => !["articleKey", "runId", "newRunId", "deadline"].includes(k),
      ) ||
      typeof v.runId !== "string" ||
      typeof v.articleKey !== "string" ||
      (v.newRunId !== undefined && typeof v.newRunId !== "string") ||
      (v.deadline !== undefined &&
        (!Number.isSafeInteger(v.deadline) || v.deadline <= Date.now()))
    )
      return denied;
    if (
      env.SEO_RESEARCH_ENABLED !== "true" ||
      env.SEO_EDITORIAL_ENABLED !== "true"
    )
      return denied;
    const row = await env.CMS_AI_DB.prepare(
      `SELECT j.id,j.site_id,j.github_run_id,j.base_sha,j.source_sha256,x.receipt_sha256,x.receipt_json FROM seo_editorial_jobs j
   JOIN seo_editorial_runs r ON r.run_id=j.run_id AND r.job_id=j.id JOIN seo_research_rejections x ON x.job_id=j.id AND x.run_id=r.run_id
   LEFT JOIN seo_plan_contracts p ON p.job_id=j.id WHERE r.run_id=? AND j.article_key=? AND r.article_key=j.article_key
   AND COALESCE(p.version,1)=1 AND j.status='unresolved' AND r.status='unresolved' AND r.pr_url IS NULL
   AND j.generation_started=0 AND j.publication_started=0 AND j.next_step=0 AND j.call_id IS NULL AND j.callback_recorded=1
   AND NOT EXISTS(SELECT 1 FROM seo_editorial_jobs k WHERE k.run_id=r.run_id AND k.status NOT IN ('unresolved','ineligible'))`,
    )
      .bind(v.runId, v.articleKey)
      .first<any>();
    if (!row || (await sha256(row.receipt_json)) !== row.receipt_sha256)
      return denied;
    const receipt = JSON.parse(row.receipt_json);
    if (
      receipt.reason !== "confirmed_insufficient" ||
      receipt.runId !== v.runId ||
      receipt.jobId !== row.id ||
      receipt.articleKey !== v.articleKey ||
      receipt.sourceSha256 !== row.source_sha256 ||
      receipt.generationCalls !== 0 ||
      receipt.generationArtifacts !== 0 ||
      receipt.publicationStarted !== false ||
      !Array.isArray(receipt.refs) ||
      receipt.refs.length ||
      !Array.isArray(receipt.pullRequests) ||
      receipt.pullRequests.length
    )
      return denied;
    const saved = await env.CMS_AI_IMAGES.get(
      `seo-editorial/${row.id}/rejection.json`,
    );
    if (
      !saved ||
      (await saved.text()) !== row.receipt_json ||
      (await env.CMS_AI_IMAGES.get(`seo-editorial/${row.id}/step-0.json`))
    )
      return denied;
    let deadline = Math.min(Date.now() + 15000, v.deadline ?? Infinity);
    if (v.newRunId !== undefined) {
      if (v.newRunId === v.runId) return denied;
      const fresh = await env.CMS_AI_DB.prepare(
        `SELECT j.id,r.deadline FROM seo_editorial_jobs j JOIN seo_editorial_runs r ON r.run_id=j.run_id AND r.job_id=j.id JOIN seo_plan_contracts p ON p.job_id=j.id
    WHERE r.run_id=? AND r.status='pending' AND r.deadline>? AND j.status='claiming' AND p.version=2
    AND j.article_key=? AND j.source_sha256=? AND j.claim_recorded=0 AND j.generation_started=0 AND j.publication_started=0`,
      )
        .bind(v.newRunId, Date.now(), v.articleKey, row.source_sha256)
        .first();
      if (!fresh) return denied;
      deadline = Math.min(deadline, Number(fresh.deadline));
    }
    const site = getSiteById(row.site_id);
    if (
      !site ||
      !row.github_run_id ||
      !row.base_sha ||
      !(await seoWorkflowCompleted(
        env,
        site,
        row.github_run_id,
        row.base_sha,
        deadline,
      ))
    )
      return denied;
    return {
      status: "eligible" as const,
      version: 1,
      runId: v.runId,
      articleKey: v.articleKey,
      sourceSha256: row.source_sha256,
      receiptSha256: row.receipt_sha256,
      fromPlan: 1,
      toPlan: 2,
      ...(v.newRunId === undefined ? {} : { newRunId: v.newRunId }),
    };
  } catch {
    return denied;
  }
}
