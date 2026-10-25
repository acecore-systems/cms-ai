import type { AppEnv } from "./env.ts";
import { deepseekPayload, deepseekUpperCost } from "./seo-deepseek.ts";
import { jstMonth, newJobMonthLimit } from "./seo-budget.ts";
import { assertStageInput } from "./seo-stage-budget.ts";
import { sha256 } from "./seo-hash.ts";
import { proofObjects } from "./seo-proof-objects.ts";
import { seoWorkflowCompleted, seoPublicationAbsent } from "./github.ts";
import { getSiteById } from "./sites.ts";
import {
  sourceIdentity,
  assertEditorialFiles,
  assertFormattedSource,
  normalizeLf,
} from "./seo-content.ts";
import { parsePlan } from "./seo-research-plan.ts";
import { parseDiscovery } from "./seo-discovery.ts";
import { externalScope } from "./seo-external-sources.ts";
import { responseText } from "./seo-responses.ts";
import {
  loadSourceRecovery,
  recoveryDiscovery,
} from "./seo-source-recovery.ts";

function reject(): never {
  throw Error("seo_continuation_evidence");
}
// JSON property order is transport syntax, not article content. Keep the stored
// bundle/manifest bytes unchanged and compare every exact path/content pair.
export function sameContinuationSource(
  value: unknown,
  expected: { path: string; content: string }[],
) {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  const byPath = new Map(expected.map((file) => [file.path, file.content]));
  const seen = new Set<string>();
  if (byPath.size !== expected.length) return false;
  return value.every((file) => {
    if (
      !file ||
      typeof file !== "object" ||
      Array.isArray(file) ||
      Object.keys(file).sort().join() !== "content,path" ||
      typeof file.path !== "string" ||
      typeof file.content !== "string" ||
      seen.has(file.path) ||
      !byPath.has(file.path) ||
      byPath.get(file.path) !== file.content
    )
      return false;
    seen.add(file.path);
    return true;
  });
}
const runId =
  /^(editorial|manual)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function continuationInput(input: any) {
  if (
    !input ||
    Object.keys(input).sort().join() !== "deadline,newRunId,oldRunId" ||
    !runId.test(input.oldRunId) ||
    !runId.test(input.newRunId) ||
    input.oldRunId === input.newRunId ||
    !Number.isSafeInteger(input.deadline) ||
    input.deadline <= Date.now() ||
    input.deadline > Date.now() + 1800000
  )
    reject();
  return input as { oldRunId: string; newRunId: string; deadline: number };
}
export async function continuationRow(env: AppEnv, jobId: string) {
  return env.CMS_AI_DB.prepare(
    "SELECT * FROM seo_review_continuations WHERE job_id=?",
  )
    .bind(jobId)
    .first<any>();
}

// The old job is read-only. No new check is fabricated for inherited work.
export async function inspectReviewContinuation(
  env: AppEnv,
  oldRunId: string,
  newDeadline: number,
  github = true,
) {
  if (
    env.SEO_EDITORIAL_ENABLED !== "true" ||
    env.SEO_RESEARCH_ENABLED !== "true"
  )
    reject();
  const { jobRow, runRow, checkContext } = await import("./seo-editorial.ts");
  const { loadResearch, parseResearch, buildReviewRequest } =
    await import("./seo-checks.ts");
  const run = await runRow(env, oldRunId);
  const job = run?.job_id ? await jobRow(env, run.job_id) : null;
  if (
    !run ||
    !job ||
    run.status !== "unresolved" ||
    run.pr_url !== null ||
    run.deadline > Date.now() ||
    job.status !== "unresolved" ||
    job.generation_started !== 1 ||
    job.publication_started !== 0 ||
    job.claim_recorded !== 1 ||
    job.callback_recorded !== 1 ||
    job.next_step !== 1 ||
    job.editorial_scope !== 2 ||
    job.model_version !== 2 ||
    job.protocol_version !== 2 ||
    job.research_contract !== 2 ||
    job.retrieval_contract !== 2 ||
    job.research_recovery !== 2 ||
    job.review_output !== 2 ||
    !job.article_key ||
    !job.source_sha256 ||
    !job.base_sha ||
    !job.github_run_id ||
    job.paths_json !== JSON.stringify([job.article_path])
  )
    reject();
  if (await continuationRow(env, job.id)) reject();
  if (
    await env.CMS_AI_DB.prepare(
      "SELECT version FROM seo_review_effort_contracts WHERE job_id=?",
    )
      .bind(job.id)
      .first()
  )
    reject();
  const objects = proofObjects(env, Math.min(newDeadline, Date.now() + 30000));
  env = {
    ...objects.env,
    CMS_AI_IMAGES: {
      get: async (key: string) => {
        const o = await objects.env.CMS_AI_IMAGES.get(key);
        return o
          ? {
              text: () => o.text(),
              json: async () => JSON.parse(await o.text()),
            }
          : null;
      },
    },
  } as AppEnv;
  const artifacts: { key: string; sha256: string }[] = [];
  const read = async (key: string) => {
    const object = await env.CMS_AI_IMAGES.get(key);
    if (!object) return reject();
    const raw = await object.text();
    artifacts.push({ key, sha256: await sha256(raw) });
    return { value: JSON.parse(raw), raw, hash: await sha256(raw) };
  };
  const base = `seo-editorial/${job.id}/`;
  const checks = (
    await env.CMS_AI_DB.prepare(
      "SELECT * FROM seo_all_checks WHERE job_id=? ORDER BY phase",
    )
      .bind(job.id)
      .all<any>()
  ).results;
  const models = (
    await env.CMS_AI_DB.prepare(
      "SELECT * FROM seo_model_calls WHERE job_id=? ORDER BY call_id",
    )
      .bind(job.id)
      .all<any>()
  ).results;
  const budgets = (
    await env.CMS_AI_DB.prepare(
      "SELECT * FROM seo_budget_calls WHERE run_id=? ORDER BY id",
    )
      .bind(run.budget_run_id)
      .all<any>()
  ).results;
  const budgetRun = await env.CMS_AI_DB.prepare(
    "SELECT * FROM seo_budget_runs WHERE id=?",
  )
    .bind(run.budget_run_id)
    .first<any>();
  if (
    !budgetRun ||
    budgetRun.article_key !== job.site_id + ":" + job.article_path ||
    budgetRun.deadline !== run.deadline ||
    budgetRun.run_limit_micros !== 1250000
  )
    reject();
  if (
    checks.map((c) => c.phase).join() !== "discovery,plan,research,review" ||
    models.length !== 5 ||
    budgets.length !== 5
  )
    reject();
  const [source, final, step, generation] = await Promise.all(
    ["source", "review-input", "step-0", "step-0-call"].map((s) =>
      read(base + s + ".json"),
    ),
  );
  const candidate = JSON.parse(run.candidates_json)[job.candidate_index];
  const identity = sourceIdentity(
    candidate.site,
    candidate.url,
    source.value,
    Date.now(),
    2,
  );
  if (
    !identity ||
    identity.articleKey !== job.article_key ||
    (await sha256(normalizeLf(identity.source.content))) !==
      job.source_sha256 ||
    !Array.isArray(final.value) ||
    final.value.length !== 1 ||
    final.value[0].path !== job.article_path ||
    step.value.path !== job.article_path ||
    generation.value.step !== 0 ||
    generation.value.path !== job.article_path ||
    generation.value.acceptedSha256 !== step.hash ||
    job.call_id !== generation.value.callId
  )
    reject();
  assertFormattedSource(step.value.content, final.value[0].content);
  const responses: Record<string, any> = {};
  const results: Record<string, any> = {};
  const ids = new Set([generation.value.callId]);
  for (const c of checks) {
    if (
      c.status !== (c.phase === "review" ? "unresolved" : "complete") ||
      ids.has(c.call_id)
    )
      reject();
    ids.add(c.call_id);
    const m = await read(base + c.phase + "-call.json");
    if (
      m.value.phase !== c.phase ||
      m.value.callId !== c.call_id ||
      m.value.inputSha256 !== c.input_sha256 ||
      m.value.responseKey !== `seo-responses/${c.call_id}.json` ||
      m.value.resultKey !== base + c.phase + ".json"
    )
      reject();
    if (c.phase === "review") {
      const raw = await read(`seo-provider-responses/${c.call_id}.json`);
      const v = raw.value,
        choice = v.choices?.[0];
      if (
        v.model !== "@cf/deepseek-ai/deepseek-v4.1-flash-1017" ||
        v.choices?.length !== 1 ||
        choice.finish_reason !== "length" ||
        choice.message?.role !== "assistant" ||
        choice.message.content !== "" ||
        choice.message.refusal ||
        choice.message.tool_calls ||
        v.usage?.completion_tokens !== 24000 ||
        !Number.isSafeInteger(v.usage?.prompt_tokens) ||
        v.usage.prompt_tokens < 0 ||
        c.result_sha256 !== null ||
        c.input_sha256 !== final.hash ||
        (await env.CMS_AI_IMAGES.get(m.value.responseKey)) ||
        (await env.CMS_AI_IMAGES.get(base + "review.json"))
      )
        reject();
      const failure = await read(base + "review-failure.json");
      if (
        failure.value.code !== "seo_check_failed" ||
        failure.value.responseStored !== false ||
        failure.value.callId !== c.call_id ||
        !Number.isFinite(Date.parse(failure.value.checkedAt)) ||
        Date.parse(failure.value.checkedAt) >= run.deadline
      )
        reject();
    } else {
      responses[c.phase] = await read(m.value.responseKey);
      results[c.phase] = await read(base + c.phase + ".json");
      if (
        results[c.phase].hash !== c.result_sha256 ||
        responses[c.phase].value.status !== "completed"
      )
        reject();
    }
  }
  for (const m of models) {
    const c = checks.find((c) => c.call_id === m.call_id);
    const b = budgets.find((b) => b.id === m.call_id);
    if (
      !ids.has(m.call_id) ||
      !b ||
      m.budget_run_id !== run.budget_run_id ||
      b.request_sha256 !== m.request_sha256 ||
      m.phase !== (c?.phase ?? "generation") ||
      m.model !==
        (["discovery", "research"].includes(m.phase)
          ? "gpt-6-luna"
          : "@cf/deepseek-ai/deepseek-v4.1-flash-1017") ||
      !/^[a-f0-9]{64}$/.test(m.request_sha256) ||
      b.created_at >= run.deadline ||
      b.created_at < budgetRun.created_at ||
      b.status !== (c?.phase === "review" ? "unresolved" : "complete")
    )
      reject();
  }
  if (
    new Set(models.map((m) => m.call_id)).size !== 5 ||
    budgets.some((b) => !ids.has(b.id))
  )
    reject();
  const proposal = await read(`seo-proposals/${generation.value.callId}.json`);
  if (
    proposal.hash !== generation.value.proposalSha256 ||
    proposal.value.changes?.length !== 1 ||
    proposal.value.changes[0].path !== job.article_path
  )
    reject();
  const plan = parsePlan(
    responseText(responses.plan.value).value,
    identity.source.content,
    job.source_sha256,
    2,
    2,
  );
  if (JSON.stringify(plan) !== JSON.stringify(results.plan.value)) reject();
  const discovery = await parseDiscovery(
    responses.discovery.value,
    identity.source.content,
    plan,
    responses.discovery.raw,
    5,
    externalScope(job.site_id, identity.source),
    2,
  );
  if (JSON.stringify(discovery) !== JSON.stringify(results.discovery.value))
    reject();
  const evidence = await loadResearch(env, checkContext(job, run));
  const checked = Date.parse(evidence.checkedAt);
  if (
    !Number.isFinite(checked) ||
    checked > Date.now() ||
    checked >= run.deadline ||
    newDeadline > checked + 86400000
  )
    reject();
  const recovery =
    job.source_recovery === 2 ? await loadSourceRecovery(env, job.id) : null;
  if (recovery) await read(base + "source-recovery.json");
  const parsed = parseResearch(
    responses.research.value,
    identity.source.content,
    job.source_sha256,
    checked,
    plan,
    recovery
      ? await recoveryDiscovery(discovery, identity.source.content, recovery)
      : discovery,
  );
  if (JSON.stringify(parsed) !== JSON.stringify(evidence)) reject();
  await assertEditorialFiles(
    identity,
    source.value,
    final.value,
    evidence.sources.map((s) => s.url),
  );
  const payload = deepseekPayload(
    {
      ...buildReviewRequest(
        identity,
        source.value,
        final.value,
        evidence,
        2,
        2,
      ),
      reasoning_effort: "low",
    },
    true,
  );
  assertStageInput(
    "review",
    payload,
    job.budget_version,
    job.research_recovery,
    2,
  );
  const reviewMicros = deepseekUpperCost(payload);
  const oldPayload = { ...payload, reasoning_effort: "high" };
  const oldReview = models.find((m) => m.phase === "review");
  if (
    !oldReview ||
    oldReview.request_sha256 !== (await sha256(JSON.stringify(oldPayload))) ||
    budgets.find((b) => b.id === oldReview.call_id)?.reserved_micros !==
      deepseekUpperCost(oldPayload)
  )
    reject();
  const site = getSiteById(job.site_id);
  if (
    !site ||
    (github &&
      (!(await seoWorkflowCompleted(
        env,
        site,
        job.github_run_id,
        job.base_sha,
        newDeadline,
        "failure",
      )) ||
        !(await seoPublicationAbsent(env, site, job.id, newDeadline))))
  )
    reject();
  // Include every immutable old row and exact R2 byte digest; no provider body in manifest.
  const manifest = {
    version: 1,
    oldRunId: run.run_id,
    oldJobId: job.id,
    articleKey: job.article_key,
    sourceSha256: job.source_sha256,
    filesSha256: final.hash,
    job,
    run,
    checks,
    models,
    budgets,
    budgetRun,
    artifacts: artifacts.sort((a, b) => a.key.localeCompare(b.key)),
  };
  return {
    job,
    run,
    reviewMicros,
    manifest,
    manifestSha256: await sha256(JSON.stringify(manifest)),
    source: source.value,
    final: final.value,
    step: step.value,
    evidence,
  };
}

export async function continuationBudgetFits(env: AppEnv, amount: number) {
  const now = Date.now();
  const held = await env.CMS_AI_DB.prepare(
    "SELECT COALESCE(SUM(reserved_micros),0) AS total FROM seo_budget_calls WHERE month_jst=?",
  )
    .bind(jstMonth(now))
    .first<{ total: number }>();
  return (
    !!held &&
    Number.isSafeInteger(held.total) &&
    amount <= 1250000 &&
    held.total + amount <= newJobMonthLimit(jstMonth(now), now)
  );
}

export async function reviewContinuationProof(env: AppEnv, input: unknown) {
  try {
    const v = continuationInput(input);
    const data = await inspectReviewContinuation(env, v.oldRunId, v.deadline);
    if (!(await continuationBudgetFits(env, data.reviewMicros))) reject();
    const existing = await env.CMS_AI_DB.prepare(
      "SELECT c.*,j.status,j.claim_recorded,r.deadline,r.status AS run_status FROM seo_review_continuations c JOIN seo_editorial_jobs j ON j.id=c.job_id JOIN seo_editorial_runs r ON r.run_id=c.run_id WHERE c.old_run_id=? OR c.run_id=?",
    )
      .bind(v.oldRunId, v.newRunId)
      .first<any>();
    if (
      existing &&
      (existing.run_id !== v.newRunId ||
        existing.old_run_id !== v.oldRunId ||
        existing.manifest_sha256 !== data.manifestSha256 ||
        existing.deadline !== v.deadline ||
        existing.run_status !== "pending" ||
        !["queued", "inspecting", "claiming"].includes(existing.status) ||
        existing.claim_recorded !== 0 ||
        (await env.CMS_AI_DB.prepare(
          "SELECT call_id FROM seo_model_calls WHERE job_id=?",
        )
          .bind(existing.job_id)
          .first()))
    )
      reject();
    return {
      status: "eligible" as const,
      version: 1,
      oldRunId: v.oldRunId,
      newRunId: v.newRunId,
      oldJobId: data.job.id,
      articleKey: data.job.article_key!,
      sourceSha256: data.job.source_sha256!,
      manifestSha256: data.manifestSha256,
      filesSha256: data.manifest.filesSha256,
      checkedAt: Date.now(),
      deadline: v.deadline,
    };
  } catch {
    return { status: "denied" as const };
  }
}

export async function loadContinuation(
  env: AppEnv,
  jobId: string,
  deadline: number,
  github = false,
) {
  const row = await continuationRow(env, jobId);
  if (!row) return null;
  if (row.manifest_key !== `seo-editorial/${jobId}/continuation-manifest.json`)
    reject();
  const saved = await env.CMS_AI_IMAGES.get(row.manifest_key);
  if (!saved || (await sha256(await saved.text())) !== row.manifest_sha256)
    reject();
  const data = await inspectReviewContinuation(
    env,
    row.old_run_id,
    deadline,
    github,
  );
  if (
    data.manifestSha256 !== row.manifest_sha256 ||
    data.manifest.filesSha256 !== row.files_sha256
  )
    reject();
  return data;
}
