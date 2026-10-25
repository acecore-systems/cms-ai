import { proofObjects } from "./seo-proof-objects.ts";
import type { AppEnv } from "./env.ts";
import { sha256 } from "./seo-hash.ts";
import { sourceIdentity } from "./seo-content.ts";
import {
  deepseekPayload,
  deepseekUpperCost,
  normalizedDeepseek,
  validateDeepseekResponse,
} from "./seo-deepseek.ts";
import { assertStageInput } from "./seo-stage-budget.ts";
import { responseText } from "./seo-responses.ts";
import { validateScopedReview } from "./seo-review-scope.ts";
import { seoWorkflowCompleted, seoPublicationAbsent } from "./github.ts";
import { getSiteById } from "./sites.ts";
import { SEO_CONTINUATION_VERIFY_MS } from "./seo-time-bounds.ts";
function fail(): never {
  throw Error("seo_review_scope_evidence");
}
const exact = (v: any, k: string) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join() === k;
async function read(env: AppEnv, key: string) {
  const o = await env.CMS_AI_IMAGES.get(key);
  if (!o) fail();
  const raw = await o.text();
  return { value: JSON.parse(raw), raw, hash: await sha256(raw) };
}

// Full completed-fail proof; no old response, state, deadline or reservation changes.
export async function inspectScopeRejection(
  env: AppEnv,
  job: any,
  run: any,
  data: any,
  scope: 1 | 2,
  deadline: number,
  github: boolean,
) {
  const { buildReviewRequest } = await import("./seo-checks.ts");
  if (
    !["generated", "unresolved"].includes(job.status) ||
    !["pending", "unresolved"].includes(run.status) ||
    run.job_id !== job.id ||
    job.run_id !== run.run_id ||
    job.claim_recorded !== 1 ||
    job.generation_started !== 0 ||
    job.publication_started !== 0 ||
    job.next_step !== 1 ||
    job.call_id !== null ||
    !job.base_sha ||
    !job.github_run_id ||
    run.pr_url !== null ||
    job.article_key !== data.job.article_key ||
    job.source_sha256 !== data.job.source_sha256 ||
    job.article_path !== data.job.article_path ||
    job.paths_json !== data.job.paths_json ||
    job.site_id !== data.job.site_id
  )
    fail();
  const base = `seo-editorial/${job.id}/`;
  const objects = proofObjects(env, deadline);
  env = objects.env;
  await objects.prefetch(
    [
      "source.json",
      "review-input.json",
      "review-call.json",
      "review-failure.json",
    ].map((name) => ({ key: base + name, body: true })),
  );
  const source = await read(env, base + "source.json"),
    final = await read(env, base + "review-input.json"),
    manifest = await read(env, base + "review-call.json"),
    failure = await read(env, base + "review-failure.json");
  if (
    source.raw !== JSON.stringify(data.source) ||
    final.hash !== data.manifest.filesSha256 ||
    JSON.stringify(final.value) !== JSON.stringify(data.final) ||
    (await env.CMS_AI_IMAGES.get(base + "review.json"))
  )
    fail();
  const checks = (
    await env.CMS_AI_DB.prepare("SELECT * FROM seo_all_checks WHERE job_id=?")
      .bind(job.id)
      .all<any>()
  ).results;
  const models = (
    await env.CMS_AI_DB.prepare("SELECT * FROM seo_model_calls WHERE job_id=?")
      .bind(job.id)
      .all<any>()
  ).results;
  const budgets = (
    await env.CMS_AI_DB.prepare("SELECT * FROM seo_budget_calls WHERE run_id=?")
      .bind(run.budget_run_id)
      .all<any>()
  ).results;
  const budgetRun = await env.CMS_AI_DB.prepare(
    "SELECT * FROM seo_budget_runs WHERE id=?",
  )
    .bind(run.budget_run_id)
    .first<any>();
  if (
    checks.length !== 1 ||
    models.length !== 1 ||
    budgets.length !== 1 ||
    !budgetRun
  )
    fail();
  const c = checks[0],
    m = models[0],
    b = budgets[0],
    f = failure.value;
  if (
    c.phase !== "review" ||
    c.status !== "unresolved" ||
    c.result_sha256 !== null ||
    c.input_sha256 !== final.hash ||
    m.phase !== "review" ||
    m.call_id !== c.call_id ||
    m.budget_run_id !== run.budget_run_id ||
    b.id !== c.call_id ||
    b.status !== "complete" ||
    b.request_sha256 !== m.request_sha256 ||
    b.created_at < run.created_at ||
    b.created_at >= run.deadline ||
    budgetRun.deadline !== run.deadline ||
    budgetRun.run_limit_micros !== 1250000 ||
    budgetRun.article_key !== job.site_id + ":" + job.article_path ||
    manifest.value.phase !== "review" ||
    manifest.value.callId !== c.call_id ||
    manifest.value.inputSha256 !== final.hash ||
    manifest.value.responseKey !== `seo-responses/${c.call_id}.json` ||
    manifest.value.resultKey !== base + "review.json" ||
    f.phase !== "review" ||
    f.callId !== c.call_id ||
    f.responseKey !== manifest.value.responseKey ||
    f.code !== "seo_ai_review_failed" ||
    f.responseStored !== true ||
    !Number.isFinite(Date.parse(f.checkedAt)) ||
    Date.parse(f.checkedAt) < b.created_at ||
    Date.parse(f.checkedAt) >= run.deadline ||
    Date.parse(f.checkedAt) > Date.now()
  )
    fail();
  const response = await read(env, manifest.value.responseKey),
    provider = await read(env, `seo-provider-responses/${c.call_id}.json`);
  const candidate = JSON.parse(run.candidates_json)[job.candidate_index];
  const identity = sourceIdentity(
    candidate.site,
    candidate.url,
    data.source,
    Date.now(),
    2,
  );
  if (!identity || identity.articleKey !== job.article_key) fail();
  const payload = deepseekPayload(
    {
      ...buildReviewRequest(
        identity,
        data.source,
        data.final,
        data.evidence,
        2,
        2,
        scope,
      ),
      reasoning_effort: "low",
    },
    true,
  );
  if (
    m.model !== "@cf/deepseek-ai/deepseek-v4.1-flash-1017" ||
    m.request_sha256 !== (await sha256(JSON.stringify(payload))) ||
    b.reserved_micros !== deepseekUpperCost(payload)
  )
    fail();
  validateDeepseekResponse(provider.value, payload, deadline);
  if (JSON.stringify(normalizedDeepseek(provider.value)) !== response.raw)
    fail();
  const v = responseText(response.value).value;
  if (scope === 2) validateScopedReview(v, data.source, data.final);
  else if (
    !exact(v, "files,verdict") ||
    !Array.isArray(v.files) ||
    v.files.length !== 1 ||
    v.files.some(
      (x: any) =>
        !exact(
          x,
          "issues,meaningPreserved,naturalLanguage,path,referencesSupported",
        ) ||
        x.path !== job.article_path ||
        [x.meaningPreserved, x.naturalLanguage, x.referencesSupported].some(
          (z) => typeof z !== "boolean",
        ) ||
        !Array.isArray(x.issues) ||
        x.issues.some((s: any) => typeof s !== "string" || !s.trim()),
    )
  )
    fail();
  if (v.verdict !== "fail" || !v.files.some((x: any) => x.issues.length))
    fail();
  const site = getSiteById(job.site_id);
  if (!site) fail();
  if (
    github &&
    (!(await seoWorkflowCompleted(
      env,
      site,
      job.github_run_id,
      job.base_sha,
      deadline,
      "failure",
      true,
      1,
    )) ||
      !(await seoPublicationAbsent(env, site, job.id, deadline, true)))
  )
    fail();
  if (Date.now() >= deadline) fail();
  const stepHash = await sha256(JSON.stringify(data.step));
  const receipt = {
    version: 5,
    runId: run.run_id,
    jobId: job.id,
    articleKey: job.article_key,
    sourceSha256: job.source_sha256,
    deadline: run.deadline,
    calls: [
      {
        phase: "review",
        callId: c.call_id,
        responseSha256: response.hash,
        manifestSha256: manifest.hash,
        status: "completed",
      },
    ],
    files: [
      {
        path: job.article_path,
        acceptedSha256: stepHash,
        finalSha256: await sha256(final.value[0].content),
      },
    ],
    filesSha256: final.hash,
    sourceBundleSha256: source.hash,
    reason: "confirmed_review_rejection",
    researchContract: 2,
    generationCalls: 0,
    generationArtifacts: 0,
    publicationStarted: false,
    baseSha: job.base_sha,
    githubRunId: job.github_run_id,
    refs: [],
    pullRequests: [],
    decisionTime: Date.parse(f.checkedAt),
    reviewScope: scope,
    rootRunId: data.run.run_id,
    rootJobId: data.job.id,
    manifestSha256: data.manifestSha256,
    inheritedGenerationArtifacts: 1,
  };
  return {
    receipt,
    rejectionSha256: await sha256(JSON.stringify(receipt)),
    checks,
    models,
    budgets,
    budgetRun,
    artifacts: [
      { key: base + "review-failure.json", sha256: failure.hash },
      {
        key: `seo-provider-responses/${c.call_id}.json`,
        sha256: provider.hash,
      },
    ],
  };
}

export async function inspectScopeReassessment(
  env: AppEnv,
  oldRunId: string,
  deadline: number,
  github = true,
  verifiedRoot?: any,
  verificationDeadline = Math.min(
    deadline,
    Date.now() + SEO_CONTINUATION_VERIFY_MS,
  ),
): Promise<any> {
  const { jobRow, runRow } = await import("./seo-editorial.ts");
  const { loadContinuation } = await import("./seo-review-continuation.ts");
  const { buildReviewRequest } = await import("./seo-checks.ts");
  const run = await runRow(env, oldRunId);
  if (!run?.job_id || run.status !== "unresolved" || run.deadline > Date.now())
    fail();
  const row = await env.CMS_AI_DB.prepare(
    "SELECT * FROM seo_review_continuation_retries WHERE run_id=? AND job_id=?",
  )
    .bind(oldRunId, run.job_id)
    .first<any>();
  if (
    !row ||
    (await env.CMS_AI_DB.prepare(
      "SELECT job_id FROM seo_review_scope_reassessments WHERE job_id=?",
    )
      .bind(run.job_id)
      .first())
  )
    fail();
  const job = await jobRow(env, run.job_id);
  if (!job || job.callback_recorded !== 1) fail();
  const data = await loadContinuation(
    env,
    job.id,
    deadline,
    github,
    undefined,
    verifiedRoot,
    verificationDeadline,
  );
  if (!data || data.continuationVersion !== 2) fail();
  const rejected = await inspectScopeRejection(
    env,
    job,
    run,
    data,
    1,
    verificationDeadline,
    github,
  );
  const candidate = JSON.parse(run.candidates_json)[job.candidate_index];
  const identity = sourceIdentity(
    candidate.site,
    candidate.url,
    data.source,
    Date.now(),
    2,
  );
  if (!identity) fail();
  const payload = deepseekPayload(
    {
      ...buildReviewRequest(
        identity,
        data.source,
        data.final,
        data.evidence,
        2,
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
  const scope = {
    previousJob: job,
    previousRun: run,
    continuation: row,
    rejected,
  };
  const registrationManifest = {
    version: 3,
    root: data.manifest,
    previous: scope,
  };
  if (Date.now() >= verificationDeadline) fail();
  return {
    ...data,
    reviewMicros: deepseekUpperCost(payload),
    retry: null,
    scope,
    registrationManifest,
    registrationSha256: await sha256(JSON.stringify(registrationManifest)),
  };
}

export async function prepareScopedRejection(
  env: AppEnv,
  job: any,
  run: any,
  verified?: any,
) {
  const { loadContinuation } = await import("./seo-review-continuation.ts");
  const { immutableReviewObject } = await import("./seo-review-rejection.ts");
  const data =
    verified ?? (await loadContinuation(env, job.id, run.deadline, true));
  if (!data || data.continuationVersion !== 3) fail();
  const checked = await inspectScopeRejection(
    env,
    job,
    run,
    data,
    2,
    Math.min(run.deadline, Date.now() + 30000),
    false,
  );
  return immutableReviewObject(
    env,
    `seo-editorial/${job.id}/review-rejection-offer.json`,
    checked.receipt,
  );
}
export async function finalizeScopedRejection(
  env: AppEnv,
  job: any,
  run: any,
  body: any,
) {
  const { immutableReviewObject, notifyReviewRejection } =
    await import("./seo-review-rejection.ts");
  if (
    !exact(body, "baseSha,offerSha256,pullRequests,refs") ||
    body.baseSha !== job.base_sha ||
    !Array.isArray(body.refs) ||
    body.refs.length ||
    !Array.isArray(body.pullRequests) ||
    body.pullRequests.length
  )
    fail();
  const offer = await read(
    env,
    `seo-editorial/${job.id}/review-rejection-offer.json`,
  );
  if (offer.hash !== body.offerSha256) fail();
  const existing = await env.CMS_AI_DB.prepare(
    "SELECT receipt_sha256 FROM seo_scope_review_rejections WHERE job_id=?",
  )
    .bind(job.id)
    .first<any>();
  if (existing) {
    if (existing.receipt_sha256 !== offer.hash) fail();
  } else {
    if ((await prepareScopedRejection(env, job, run)) !== offer.hash) fail();
    const site = getSiteById(job.site_id);
    if (
      !site ||
      !(await seoPublicationAbsent(env, site, job.id, run.deadline, true))
    )
      fail();
    await immutableReviewObject(
      env,
      `seo-editorial/${job.id}/review-rejection.json`,
      offer.value,
    );
    await env.CMS_AI_DB.prepare(
      "INSERT INTO seo_scope_review_rejections(job_id,run_id,review_scope,receipt_sha256,receipt_json,created_at) VALUES(?,?,2,?,?,?)",
    )
      .bind(job.id, run.run_id, offer.hash, offer.raw, Date.now())
      .run();
  }
  return {
    status: (await notifyReviewRejection(env, job))
      ? "review_rejected"
      : "unresolved",
    receiptSha256: offer.hash,
  };
}
