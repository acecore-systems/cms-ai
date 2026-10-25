import type { ContinuationProgress } from "./seo-review-continuation.ts";
import { SEO_CONTINUATION_VERIFY_MS } from "./seo-time-bounds.ts";
import type { AppEnv } from "./env.ts";
import { sha256 } from "./seo-hash.ts";
import { getSiteById } from "./sites.ts";
import { seoWorkflowCompleted, seoPublicationAbsent } from "./github.ts";

function reject(): never {
  throw Error("seo_continuation_retry_evidence");
}
const exact = (v: any, keys: string) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join() === keys;

// A single extra continuation, from an expired, entirely unconsumed v1 claim.
// This validates the immediate predecessor as well as the original generated work.
export async function inspectContinuationRequest(
  env: AppEnv,
  oldRunId: string,
  deadline: number,
  github = true,
  verifiedRoot?: Awaited<
    ReturnType<
      typeof import("./seo-review-continuation.ts").inspectReviewContinuation
    >
  >,
  verificationDeadline = Math.min(
    deadline,
    Date.now() + SEO_CONTINUATION_VERIFY_MS,
  ),
  progress: ContinuationProgress = () => {},
) {
  const { inspectReviewContinuation } =
    await import("./seo-review-continuation.ts");
  const { jobRow, runRow } = await import("./seo-editorial.ts");
  const run = await runRow(env, oldRunId);
  if (!run?.job_id) reject();
  if (
    await env.CMS_AI_DB.prepare(
      "SELECT job_id FROM seo_review_continuation_retries WHERE run_id=?",
    )
      .bind(oldRunId)
      .first()
  )
    reject();
  const previous = await env.CMS_AI_DB.prepare(
    "SELECT * FROM seo_review_continuations WHERE run_id=? AND job_id=?",
  )
    .bind(oldRunId, run.job_id)
    .first<any>();
  if (!previous) {
    const root = await inspectReviewContinuation(
      env,
      oldRunId,
      deadline,
      github,
      undefined,
      verificationDeadline,
    );
    return {
      ...root,
      retry: null,
      registrationManifest: root.manifest,
      registrationSha256: root.manifestSha256,
    };
  }
  progress("retry-state");
  const job = await jobRow(env, run.job_id);
  if (
    !job ||
    run.status !== "unresolved" ||
    job.status !== "unresolved" ||
    run.deadline > Date.now() ||
    run.pr_url !== null ||
    job.claim_recorded !== 0 ||
    job.base_sha !== null ||
    job.call_id !== null ||
    job.generation_started !== 0 ||
    job.publication_started !== 0 ||
    job.next_step !== 1 ||
    !job.github_run_id ||
    job.callback_recorded !== 1 ||
    run.article_key !== job.article_key ||
    previous.article_key !== job.article_key
  )
    reject();
  for (const query of [
    ["SELECT 1 FROM seo_model_calls WHERE job_id=?", job.id],
    ["SELECT 1 FROM seo_all_checks WHERE job_id=?", job.id],
    ["SELECT 1 FROM seo_budget_calls WHERE run_id=?", run.budget_run_id],
    ["SELECT 1 FROM seo_budget_runs WHERE id=?", run.budget_run_id],
  ])
    if (await env.CMS_AI_DB.prepare(query[0]!).bind(query[1]).first()) reject();
  progress("retry-objects");
  const base = `seo-editorial/${job.id}/`;
  for (const suffix of [
    "source.json",
    "review-input.json",
    "review.json",
    "step-0.json",
    "step-0-call.json",
    "review-call.json",
    "review-failure.json",
  ]) {
    if (await env.CMS_AI_IMAGES.get(base + suffix)) reject();
  }
  const read = async (key: string) => {
    const obj = await env.CMS_AI_IMAGES.get(key);
    if (!obj) reject();
    const raw = await obj.text();
    return { value: JSON.parse(raw), hash: await sha256(raw) };
  };
  const failure = await read(base + "failure.json");
  if (
    !exact(failure.value, "code,operation,step") ||
    failure.value.operation !== "claim" ||
    failure.value.step !== 1 ||
    !["unexpected_error", "seo_continuation_source"].includes(
      failure.value.code,
    )
  )
    reject();
  const attempts = await read(base + "claim-attempts.json");
  const a = attempts.value;
  if (
    !exact(a, "attempts,failureSha256,jobId,runId,version") ||
    a.version !== 1 ||
    a.jobId !== job.id ||
    a.runId !== run.run_id ||
    a.failureSha256 !== failure.hash ||
    !Array.isArray(a.attempts) ||
    a.attempts.length !== 2 ||
    a.attempts.some(
      (v: any) =>
        !exact(v, "headSha,runId") ||
        !/^[1-9][0-9]*$/.test(v.runId) ||
        !/^[a-f0-9]{40}$/.test(v.headSha),
    ) ||
    a.attempts[0].runId === a.attempts[1].runId ||
    a.attempts[1].runId !== job.github_run_id
  )
    reject();
  if (previous.manifest_key !== base + "continuation-manifest.json") reject();
  const saved = await read(previous.manifest_key);
  const root =
    verifiedRoot ??
    (await inspectReviewContinuation(
      env,
      previous.old_run_id,
      deadline,
      github,
      undefined,
      verificationDeadline,
    ));
  if (
    previous.old_job_id !== root.job.id ||
    saved.hash !== previous.manifest_sha256 ||
    saved.hash !== root.manifestSha256 ||
    previous.files_sha256 !== root.manifest.filesSha256 ||
    job.article_key !== root.job.article_key ||
    job.source_sha256 !== root.job.source_sha256 ||
    job.article_path !== root.job.article_path ||
    job.paths_json !== root.job.paths_json ||
    job.site_id !== root.job.site_id
  )
    reject();
  for (const field of [
    "protocol_version",
    "research_contract",
    "retrieval_contract",
    "budget_version",
    "discovery_policy",
    "generation_syntax",
    "external_sources",
    "research_context",
    "allocation_version",
    "variable_review",
    "reference_policy",
    "url_instructions",
    "research_recovery",
    "discovery_instructions",
    "code_preservation",
    "review_output",
    "metadata_preservation",
    "code_token_repair",
    "editorial_scope",
    "plan_instructions",
    "research_focus",
    "retrieval_fallback",
    "source_recovery",
    "model_version",
    "generation_output",
  ] as const)
    if (job[field] !== root.job[field]) reject();
  const site = getSiteById(job.site_id);
  if (!site) reject();
  progress("retry-github");
  if (github) {
    for (const attempt of a.attempts)
      if (
        !(await seoWorkflowCompleted(
          env,
          site,
          attempt.runId,
          attempt.headSha,
          verificationDeadline,
          "failure",
          true,
          1,
        ))
      )
        reject();
    if (
      !(await seoPublicationAbsent(
        env,
        site,
        job.id,
        verificationDeadline,
        true,
      ))
    )
      reject();
  }
  if (Date.now() >= verificationDeadline) reject();
  const retry = {
    previousJob: job,
    previousRun: run,
    continuation: previous,
    attempts: a,
    artifacts: [
      { key: base + "failure.json", sha256: failure.hash },
      { key: base + "claim-attempts.json", sha256: attempts.hash },
    ],
  };
  const registrationManifest = {
    version: 2,
    root: root.manifest,
    previous: retry,
  };
  return {
    ...root,
    retry,
    registrationManifest,
    registrationSha256: await sha256(JSON.stringify(registrationManifest)),
  };
}
