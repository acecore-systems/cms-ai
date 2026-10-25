import { verifyFocusReconsideration } from "./seo-research-focus.ts";
import type { AppEnv } from "./env.ts";
import { sha256 } from "./seo-hash.ts";
import { seoWorkflowCompleted, seoPublicationAbsent } from "./github.ts";
import { getSiteById } from "./sites.ts";
// Read-only service proof. Never replays an old job, model call or callback.
export async function reconsiderationProof(env: AppEnv, input: unknown) {
  const denied = { status: "denied" as const };
  const started = Date.now();
  let stage = "input",
    deadline: number | undefined;
  const timings: Record<string, number> = {};
  let stageStarted = started;
  const enter = (next: string) => {
    timings[stage] = Date.now() - stageStarted;
    stage = next;
    stageStarted = Date.now();
  };
  const report = (outcome: "denied" | "eligible", code = "predicate") => {
    // Never log input, identifiers, source/receipt contents, error messages or tokens.
    console.info(
      JSON.stringify({
        event: "seo_reconsideration_result",
        outcome,
        stage,
        code,
        elapsedMs: Date.now() - started,
        ...(deadline === undefined
          ? {}
          : { remainingMs: deadline - Date.now() }),
        stagesMs: { ...timings, [stage]: Date.now() - stageStarted },
      }),
    );
  };
  const reject = (code = "predicate") => {
    report("denied", code);
    return denied;
  };
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
      return reject();
    if (
      env.SEO_RESEARCH_ENABLED !== "true" ||
      env.SEO_EDITORIAL_ENABLED !== "true"
    )
      return reject();
    deadline = Math.min(Date.now() + 15000, v.deadline ?? Infinity);
    enter("old-row");
    const row = await env.CMS_AI_DB.prepare(
      `SELECT j.*,r.deadline AS run_deadline,r.budget_run_id,COALESCE(p.version,1) AS plan_version,COALESCE(f.version,1) AS research_focus,x.receipt_sha256,x.receipt_json FROM seo_editorial_jobs j
   JOIN seo_editorial_runs r ON r.run_id=j.run_id AND r.job_id=j.id JOIN seo_research_rejections x ON x.job_id=j.id AND x.run_id=r.run_id
   LEFT JOIN seo_plan_contracts p ON p.job_id=j.id LEFT JOIN seo_research_focus_contracts f ON f.job_id=j.id WHERE r.run_id=? AND j.article_key=? AND r.article_key=j.article_key
   AND (COALESCE(p.version,1)=1 OR (p.version=2 AND COALESCE(f.version,1)=1)) AND j.status='unresolved' AND r.status='unresolved' AND r.pr_url IS NULL
   AND j.generation_started=0 AND j.publication_started=0 AND j.next_step=0 AND j.call_id IS NULL AND j.callback_recorded=1
   AND NOT EXISTS(SELECT 1 FROM seo_editorial_jobs k WHERE k.run_id=r.run_id AND k.status NOT IN ('unresolved','ineligible'))`,
    )
      .bind(v.runId, v.articleKey)
      .first<any>();
    if (!row || (await sha256(row.receipt_json)) !== row.receipt_sha256)
      return reject();
    enter("receipt");
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
      return reject();
    enter("receipt-object");
    const saved = await env.CMS_AI_IMAGES.get(
      `seo-editorial/${row.id}/rejection.json`,
    );
    if (
      !saved ||
      (await saved.text()) !== row.receipt_json ||
      (await env.CMS_AI_IMAGES.get(`seo-editorial/${row.id}/step-0.json`))
    )
      return reject();
    const focusUpgrade = row.plan_version === 2;
    enter("focus-evidence");
    if (focusUpgrade && !(await verifyFocusReconsideration(env, row, receipt)))
      return reject();
    if (Date.now() >= deadline) return reject("deadline");
    enter("new-job");
    if (v.newRunId !== undefined) {
      if (v.newRunId === v.runId) return reject();
      const fresh = await env.CMS_AI_DB.prepare(
        `SELECT j.id,r.deadline FROM seo_editorial_jobs j JOIN seo_editorial_runs r ON r.run_id=j.run_id AND r.job_id=j.id JOIN seo_plan_contracts p ON p.job_id=j.id LEFT JOIN seo_research_focus_contracts f ON f.job_id=j.id
    WHERE r.run_id=? AND r.status='pending' AND r.deadline>? AND j.status='claiming' AND p.version=2
    AND (?=0 OR f.version=2) AND j.article_key=? AND j.source_sha256=? AND j.claim_recorded=0 AND j.generation_started=0 AND j.publication_started=0`,
      )
        .bind(
          v.newRunId,
          Date.now(),
          focusUpgrade ? 1 : 0,
          v.articleKey,
          row.source_sha256,
        )
        .first();
      if (!fresh) return reject();
      deadline = Math.min(deadline, Number(fresh.deadline));
    }
    enter("workflow");
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
      return reject();
    enter("publication");
    if (
      focusUpgrade &&
      !(await seoPublicationAbsent(env, site, row.id, deadline))
    )
      return reject();
    report("eligible", "complete");
    return {
      status: "eligible" as const,
      ...(focusUpgrade
        ? { version: 2, fromResearchFocus: 1, toResearchFocus: 2 }
        : { version: 1, fromPlan: 1, toPlan: 2 }),
      runId: v.runId,
      articleKey: v.articleKey,
      sourceSha256: row.source_sha256,
      receiptSha256: row.receipt_sha256,
      ...(v.newRunId === undefined ? {} : { newRunId: v.newRunId }),
    };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    const allowed = [
      "token_authentication",
      "token_permission_denied",
      "token_unavailable",
      "token_scope_mismatch",
      "read_authentication",
      "read_forbidden",
      "read_unavailable",
      "rate_evidence_missing",
      "rate_insufficient",
      "request_bound",
    ];
    return reject(
      typeof code === "string" && allowed.includes(code) ? code : "exception",
    );
  }
}
