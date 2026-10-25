import type { AppEnv } from "./env.ts";
import { sha256 } from "./seo-hash.ts";
import { factualSentences } from "./seo-research-plan.ts";
import { verifyRejectionEvidence } from "./seo-rejection.ts";
import { proofObjects } from "./seo-proof-objects.ts";

// Read-only eligibility for a NEW job. The old insufficient verdict stays final.
export async function verifyResearchReconsideration(
  env: AppEnv,
  row: any,
  receipt: any,
  objects = proofObjects(env, Infinity),
  expectedFocus: 1 | 2 = 1,
) {
  if (
    row.plan_version !== 2 ||
    row.research_focus !== expectedFocus ||
    row.research_contract !== 2 ||
    row.retrieval_contract !== 2 ||
    row.research_recovery !== 2 ||
    row.reference_policy !== 2 ||
    receipt.version !== 2 ||
    receipt.researchContract !== 2 ||
    receipt.deadline !== row.run_deadline ||
    receipt.baseSha !== row.base_sha ||
    receipt.githubRunId !== row.github_run_id ||
    !Number.isSafeInteger(receipt.decisionTime) ||
    receipt.decisionTime > Date.now() ||
    !Array.isArray(receipt.calls) ||
    receipt.calls.length !== 3
  )
    return false;
  env = objects.env;
  const read = async (suffix: string) => {
    const object = await env.CMS_AI_IMAGES.get(
      `seo-editorial/${row.id}/${suffix}.json`,
    );
    if (!object) throw new Error("seo_focus_evidence_missing");
    return JSON.parse(await object.text());
  };
  const [files, plan] = await Promise.all([read("source"), read("plan")]);
  if (!Array.isArray(files)) return false;
  const matches = files.filter((f: any) => f.path === row.article_path);
  if (matches.length !== 1 || typeof matches[0].content !== "string")
    return false;
  const source = matches[0].content.replace(/\r\n/g, "\n");
  if ((await sha256(source)) !== row.source_sha256) return false;
  if (
    plan.version !== 2 ||
    plan.tableContext ||
    !plan.target ||
    plan.claimMarkdown === plan.target.quote ||
    !Array.isArray(plan.requiredConditions) ||
    plan.requiredConditions.length !== 1 ||
    JSON.stringify(plan.requiredConditions[0]) !==
      JSON.stringify({
        start: 0,
        end: plan.target.quote.length,
        quote: plan.target.quote,
      }) ||
    factualSentences(plan.claimMarkdown).filter(
      (s) =>
        s.quote === plan.target.quote &&
        s.start === plan.target.start &&
        s.end === plan.target.end,
    ).length !== 1
  )
    return false;
  // Every job/model/charge row must belong to the same three completed calls.
  const checks = (
    await env.CMS_AI_DB.prepare(
      "SELECT c.phase,c.call_id,b.status,m.request_sha256,b.request_sha256 AS charged_hash,m.budget_run_id FROM seo_all_checks c LEFT JOIN seo_budget_calls b ON b.id=c.call_id LEFT JOIN seo_model_calls m ON m.call_id=c.call_id AND m.job_id=c.job_id AND m.phase=c.phase WHERE c.job_id=?",
    )
      .bind(row.id)
      .all<any>()
  ).results;
  const models = (
    await env.CMS_AI_DB.prepare(
      "SELECT call_id FROM seo_model_calls WHERE job_id=?",
    )
      .bind(row.id)
      .all<any>()
  ).results;
  const charges = (
    await env.CMS_AI_DB.prepare(
      "SELECT id FROM seo_budget_calls WHERE run_id=?",
    )
      .bind(row.budget_run_id)
      .all<any>()
  ).results;
  if (
    checks.length !== 3 ||
    models.length !== 3 ||
    charges.length !== 3 ||
    checks.some(
      (c) =>
        c.status !== "complete" ||
        c.budget_run_id !== row.budget_run_id ||
        c.request_sha256 !== c.charged_hash ||
        !receipt.calls.some(
          (r: any) => r.callId === c.call_id && r.phase === c.phase,
        ),
    ) ||
    models.some((m) => !checks.some((c) => c.call_id === m.call_id)) ||
    charges.some((b) => !checks.some((c) => c.call_id === b.id))
  )
    return false;
  const recovery = await env.CMS_AI_DB.prepare(
    "SELECT version FROM seo_source_recovery_contracts WHERE job_id=?",
  )
    .bind(row.id)
    .first<{ version: 2 }>();
  // Only the fixed, already matched three calls are prefetched. Validation below
  // still re-parses and hashes every original byte through the existing verifier.
  if (
    checks
      .map((c) => c.phase)
      .sort()
      .join() !== "discovery,plan,research"
  )
    return false;
  const base = `seo-editorial/${row.id}/`;
  await objects.prefetch([
    ...checks.flatMap((c) => [
      { key: `seo-responses/${c.call_id}.json`, body: true },
      { key: base + c.phase + "-call.json", body: true },
      { key: `seo-proposals/${c.call_id}.json`, body: false },
    ]),
    ...[
      "discovery",
      "research-failure",
      ...(recovery?.version === 2 ? ["source-recovery"] : []),
    ].map((s) => ({ key: base + s + ".json", body: true })),
    ...["research", "step-0", "step-0-call", "review", "review-call"].map(
      (s) => ({ key: base + s + ".json", body: false }),
    ),
  ]);
  const offer = await verifyRejectionEvidence(
    env,
    {
      jobId: row.id,
      runId: row.run_id,
      budgetRunId: row.budget_run_id,
      articleKey: row.article_key,
      budgetArticleKey: row.site_id + ":" + row.article_path,
      sourceSha256: row.source_sha256,
      deadline: row.run_deadline,
      contractVersion: 2,
      retrievalVersion: 2,
      recovery: 2,
      discoveryPolicy: 5,
      referencePolicy: 2,
      siteId: row.site_id,
      sourceRecovery: recovery?.version ?? 1,
    },
    source,
  );
  if (
    Object.entries(offer).some(
      ([k, v]) => JSON.stringify(v) !== JSON.stringify(receipt[k]),
    )
  )
    return false;
  for (const suffix of [
    "research",
    "step-0",
    "step-0-call",
    "review",
    "review-call",
  ])
    if (await env.CMS_AI_IMAGES.get(`seo-editorial/${row.id}/${suffix}.json`))
      return false;
  return true;
}

export async function verifyFocusReconsideration(
  env: AppEnv,
  row: any,
  receipt: any,
  objects = proofObjects(env, Infinity),
) {
  return verifyResearchReconsideration(env, row, receipt, objects, 1);
}
