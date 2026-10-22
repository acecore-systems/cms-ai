import { externalScope } from "./seo-external-sources.ts";
import { stageBudget, CURRENT_BUDGET_VERSION } from "./seo-stage-budget.ts";
import {
  immutableReviewObject,
  prepareReviewRejection,
  finalizeReviewRejection,
  notifyReviewRejection,
  reviewRejectionRow,
} from "./seo-review-rejection.ts";
import {
  prepareRejection,
  finalizeRejection,
  notifyRejection,
  rejectionRow,
} from "./seo-rejection.ts";
import type { AppEnv } from "./env.ts";
import { dispatchSeoEditorialJob } from "./github.ts";
import { sha256, jstMonth, monthBudgetMicros } from "./seo-budget.ts";
import { generateSeo, buildSeoGenerationRequest } from "./seo-generation.ts";
import { validateSourceFiles } from "./inference.ts";
import { json, HttpError, readJsonObject } from "./http.ts";
import { authenticateRunner, type RunnerIdentity } from "./oidc.ts";
import { seoArticleUrl, seoSite } from "./sites.ts";
import {
  acceptEditorialChange,
  assertFormattedSource,
  normalizeLf,
  sourceIdentity,
  type EditorialFile,
} from "./seo-content.ts";
import {
  buildPlanRequest,
  buildReviewRequest,
  researchArticle,
  loadResearch,
  reviewArticle,
  assertReview,
  type CheckContext,
} from "./seo-checks.ts";
import {
  allocateGenerationInputs,
  assertGenerationAllocation,
} from "./seo-stage-budget.ts";
import { evidenceReferences } from "./seo-evidence.ts";
import { buildEditorialInstruction } from "./seo-editorial-instruction.ts";

type Candidate = { site: string; url: string; reason: string };
type Run = {
  run_id: string;
  budget_run_id: string;
  input_sha256: string;
  deadline: number;
  candidates_json: string;
  status: "pending" | "draft_pr" | "no_eligible_article" | "unresolved";
  candidate_index: number;
  job_id: string | null;
  article_key: string | null;
  pr_url: string | null;
  created_at: number;
};
type EditorialJob = {
  id: string;
  run_id: string;
  site_id: string;
  candidate_index: number;
  status: string;
  github_run_id: string | null;
  source_sha256: string | null;
  base_sha: string | null;
  article_key: string | null;
  article_path: string | null;
  paths_json: string | null;
  call_id: string | null;
  next_step: number;
  claim_recorded: number;
  callback_recorded: number;
  protocol_version: number;
  research_contract: number;
  retrieval_contract: number;
  budget_version: number;
  discovery_policy: 2 | 3;
  generation_syntax: 1 | 2;
  external_sources: 0 | 1;
  input_allocation_sha256: string | null;
  generation_started: number;
  publication_started: number;
};
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const runPattern =
  /^(?:(?:editorial|manual)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|weekly-\d{4}-\d{2}-\d{2})$/;
const runRow = (env: AppEnv, runId: string) =>
  env.CMS_AI_DB.prepare("SELECT * FROM seo_editorial_runs WHERE run_id=?")
    .bind(runId)
    .first<Run>();
const jobRow = (env: AppEnv, jobId: string) =>
  env.CMS_AI_DB.prepare("SELECT * FROM seo_editorial_jobs WHERE id=?")
    .bind(jobId)
    .first<EditorialJob>();
const baseKey = (job: EditorialJob) => "seo-editorial/" + job.id;
const diagnosticCodes = new Set([
  "seo_research_call",
  "seo_research_evidence",
  "seo_research_no_search",
  "seo_research_insufficient",
  "seo_research_no_new_source",
  "seo_research_url",
  "seo_research_plan_invalid",
  "seo_research_plan_mismatch",
  "seo_stage_input_budget",
  "seo_check_conflict",
  "seo_check_evidence",
  "seo_check_files",
  "seo_ai_review_failed",
  "seo_frontmatter",
  "seo_article_id",
  "seo_content_unsafe",
  "seo_unverified_reference",
  "seo_code_changed",
  "seo_number_added",
  "seo_html_changed",
  "seo_change_path",
  "seo_immutable_metadata",
  "seo_no_copy_change",
  "seo_translation_hash_missing",
  "seo_update_date",
  "seo_deadline_or_terminal",
  "source_commit",
  "snapshot",
  "state",
  "identity",
  "format_source_missing",
  "format_source_changed",
  "format_source_unexpected",
  "generation",
  "generation_incomplete",
]);
async function recordFailure(
  env: AppEnv,
  job: EditorialJob,
  operation: string,
  error: unknown,
) {
  try {
    // Keep only the first failure and fixed codes; never serialize error objects,
    // messages outside this allowlist, source, upstream responses or credentials.
    await env.CMS_AI_IMAGES.put(
      baseKey(job) + "/failure.json",
      JSON.stringify({
        operation,
        step: job.next_step,
        code:
          error instanceof Error && diagnosticCodes.has(error.message)
            ? error.message
            : "unexpected_error",
      }),
      { onlyIf: { etagDoesNotMatch: "*" } },
    );
  } catch {
    // Diagnostic storage cannot prevent the authoritative unresolved transition.
  }
}
const enabled = (env: AppEnv) =>
  String(env.SEO_EDITORIAL_ENABLED) === "true" &&
  String(env.SEO_GENERATION_ENABLED) === "true" &&
  !!env.SEO_COORDINATOR;
function researchEnabled(env: AppEnv, runId: string) {
  return (
    String(env.SEO_RESEARCH_ENABLED) === "true" ||
    (/^editorial-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      runId,
    ) &&
      env.SEO_RESEARCH_CANARY_RUN_ID === runId)
  );
}
function alive(run: Run) {
  if (Date.now() >= run.deadline || run.status !== "pending")
    throw new Error("seo_deadline_or_terminal");
}

// A start is persisted before dispatch. A duplicate/uncertain dispatch is never retried.
export async function startEditorial(env: AppEnv, input: unknown) {
  if (!enabled(env)) return { status: "stopped" as const };
  try {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("input");
    const value = input as Record<string, unknown>;
    if (
      Object.keys(value).sort().join() !== "candidates,deadline,runId" ||
      typeof value.runId !== "string" ||
      !runPattern.test(value.runId) ||
      !Number.isSafeInteger(value.deadline) ||
      !Array.isArray(value.candidates) ||
      value.candidates.length > 3
    )
      throw new Error("input");
    const candidates: Candidate[] = value.candidates.map((raw) => {
      if (
        !raw ||
        typeof raw !== "object" ||
        typeof raw.site !== "string" ||
        !seoSite(raw.site) ||
        typeof raw.url !== "string" ||
        raw.url.length > 2048 ||
        (raw.reason !== undefined &&
          (typeof raw.reason !== "string" || raw.reason.length > 2000))
      )
        throw new Error("candidate");
      const spec = seoSite(raw.site)!;
      const url = new URL(raw.url);
      if (
        url.origin !== new URL(spec.site.canonicalUrl).origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        /[\\\s]/u.test(raw.url)
      )
        throw new Error("candidate");
      return {
        site: spec.key,
        url: raw.url,
        reason: raw.reason || "選定理由の追加情報なし",
      };
    });
    const deadline = value.deadline as number;
    const inputHash = await sha256(JSON.stringify({ deadline, candidates }));
    const existing = await runRow(env, value.runId);
    if (existing) {
      if (existing.input_sha256 !== inputHash)
        return { status: "unresolved" as const };
      return {
        status:
          existing.status === "unresolved"
            ? ("unresolved" as const)
            : ("started" as const),
        ...(existing.job_id ? { jobId: existing.job_id } : {}),
      };
    }
    const now = Date.now();
    if (deadline <= now || deadline > now + 30 * 60_000)
      return { status: "stopped" as const };
    const inserted = await env.CMS_AI_DB.prepare(
      "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(run_id) DO NOTHING",
    )
      .bind(
        value.runId,
        "seo-" + crypto.randomUUID(),
        inputHash,
        deadline,
        JSON.stringify(candidates),
        now,
      )
      .run();
    if (inserted.meta.changes === 1) await advance(env, value.runId);
    const run = await runRow(env, value.runId);
    return {
      status:
        run?.status === "unresolved"
          ? ("unresolved" as const)
          : ("started" as const),
      ...(run?.job_id ? { jobId: run.job_id } : {}),
    };
  } catch {
    return { status: "unresolved" as const };
  }
}

async function advance(env: AppEnv, runId: string) {
  let run = await runRow(env, runId);
  if (!run) throw new Error("run");
  const candidates: Candidate[] = JSON.parse(run.candidates_json);
  while (run.candidate_index < candidates.length) {
    alive(run);
    const candidate = candidates[run.candidate_index];
    const target = seoArticleUrl(candidate.site, candidate.url);
    if (!target) {
      const changed = await env.CMS_AI_DB.prepare(
        "UPDATE seo_editorial_runs SET candidate_index=candidate_index+1 WHERE run_id=? AND candidate_index=? AND job_id IS NULL AND status='pending'",
      )
        .bind(runId, run.candidate_index)
        .run();
      if (changed.meta.changes !== 1) return;
      run = (await runRow(env, runId))!;
      continue;
    }
    const jobId = crypto.randomUUID();
    const transaction = await env.CMS_AI_DB.batch([
      env.CMS_AI_DB.prepare(
        "INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index,protocol_version,research_contract,retrieval_contract,budget_version,discovery_policy,generation_syntax,external_sources) SELECT ?,run_id,?,candidate_index,?,?,?,?,?,?,? FROM seo_editorial_runs WHERE run_id=? AND job_id IS NULL AND status='pending' AND candidate_index=?",
      ).bind(
        jobId,
        target.spec.site.id,
        researchEnabled(env, runId) ? 2 : 1,
        researchEnabled(env, runId) ? 2 : 1,
        researchEnabled(env, runId) ? 2 : 1,
        CURRENT_BUDGET_VERSION,
        3,
        2,
        1,
        runId,
        run.candidate_index,
      ),
      env.CMS_AI_DB.prepare(
        "UPDATE seo_editorial_runs SET job_id=? WHERE run_id=? AND job_id IS NULL AND status='pending' AND EXISTS(SELECT 1 FROM seo_editorial_jobs WHERE id=?)",
      ).bind(jobId, runId, jobId),
    ]);
    if (transaction[1].meta.changes !== 1) return;
    try {
      await dispatchSeoEditorialJob(
        env,
        target.spec.site,
        runId,
        jobId,
        run.deadline,
      );
    } catch {
      await markUnresolved(env, jobId);
    }
    return;
  }
  await env.CMS_AI_DB.prepare(
    "UPDATE seo_editorial_runs SET status='no_eligible_article' WHERE run_id=? AND status='pending' AND job_id IS NULL",
  )
    .bind(runId)
    .run();
}

async function notify(env: AppEnv, run: Run, job: EditorialJob) {
  const reviewRejection = await notifyReviewRejection(env, job);
  if (reviewRejection !== null) return reviewRejection;
  const rejection = await notifyRejection(env, job);
  if (rejection !== null) return rejection;
  if (
    job.callback_recorded ||
    !job.article_key ||
    !["draft_pr", "unresolved"].includes(run.status)
  )
    return true;
  try {
    const response = await env.SEO_COORDINATOR!.complete({
      runId: run.run_id,
      articleKey: job.article_key,
      status: run.status === "draft_pr" ? "draft_pr" : "unresolved",
      ...(run.status === "draft_pr" && run.pr_url ? { prUrl: run.pr_url } : {}),
    });
    if (response.status !== "recorded") return false;
    await env.CMS_AI_DB.prepare(
      "UPDATE seo_editorial_jobs SET callback_recorded=1 WHERE id=?",
    )
      .bind(job.id)
      .run();
    return true;
  } catch {
    return false;
  }
}
async function markUnresolved(env: AppEnv, jobId: string) {
  const job = await jobRow(env, jobId);
  if (!job) return;
  await env.CMS_AI_DB.batch([
    env.CMS_AI_DB.prepare(
      "UPDATE seo_editorial_jobs SET status='unresolved' WHERE id=? AND status NOT IN ('draft_pr','ineligible')",
    ).bind(jobId),
    env.CMS_AI_DB.prepare(
      "UPDATE seo_editorial_runs SET status='unresolved' WHERE run_id=? AND job_id=? AND status='pending'",
    ).bind(job.run_id, jobId),
  ]);
  await notify(
    env,
    (await runRow(env, job.run_id))!,
    (await jobRow(env, jobId))!,
  );
}
export async function editorialStatus(env: AppEnv, input: unknown) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).join() !== "runId" ||
    typeof (input as { runId: unknown }).runId !== "string"
  )
    return { status: "unresolved" as const };
  try {
    let run = await runRow(env, (input as { runId: string }).runId);
    if (!run) return { status: "unresolved" as const };
    if (run.status === "pending" && Date.now() >= run.deadline) {
      if (run.job_id) await markUnresolved(env, run.job_id);
      else
        await env.CMS_AI_DB.prepare(
          "UPDATE seo_editorial_runs SET status='unresolved' WHERE run_id=? AND status='pending'",
        )
          .bind(run.run_id)
          .run();
      run = (await runRow(env, run.run_id))!;
    }
    if (
      run.job_id &&
      !(await notify(env, run, (await jobRow(env, run.job_id))!))
    )
      return {
        status: "unresolved" as const,
        ...(run.article_key ? { articleKey: run.article_key } : {}),
      };
    return {
      status:
        run.job_id && (await reviewRejectionRow(env, run.job_id))
          ? "review_rejected"
          : run.job_id && (await rejectionRow(env, run.job_id))
            ? "research_rejected"
            : run.status,
      ...(run.article_key ? { articleKey: run.article_key } : {}),
      ...(run.job_id && (await reviewRejectionRow(env, run.job_id))
        ? {
            receiptSha256: (await reviewRejectionRow(env, run.job_id))!
              .receipt_sha256,
          }
        : {}),
      ...(run.job_id && (await rejectionRow(env, run.job_id))
        ? {
            receiptSha256: (await rejectionRow(env, run.job_id))!
              .receipt_sha256,
          }
        : {}),
      ...(run.status === "draft_pr" && run.pr_url ? { prUrl: run.pr_url } : {}),
    };
  } catch {
    return { status: "unresolved" as const };
  }
}

async function authorizedJob(
  env: AppEnv,
  identity: RunnerIdentity,
  jobId: string,
  bind = false,
) {
  if (!uuid.test(jobId) || !enabled(env))
    throw new HttpError(403, "SEO runnerは利用できません。");
  let job = await jobRow(env, jobId);
  if (!job || job.site_id !== identity.site.id)
    throw new HttpError(403, "SEOジョブを確認できません。");
  const run = await runRow(env, job.run_id);
  if (!run || run.job_id !== job.id)
    throw new HttpError(409, "SEOジョブは終了しています。");
  if (bind && job.status === "queued") {
    await env.CMS_AI_DB.prepare(
      "UPDATE seo_editorial_jobs SET github_run_id=?,status='inspecting' WHERE id=? AND status='queued' AND github_run_id IS NULL",
    )
      .bind(identity.runId, jobId)
      .run();
    job = (await jobRow(env, jobId))!;
  }
  if (job.github_run_id !== identity.runId)
    throw new HttpError(403, "SEO実行を確認できません。");
  return { job, run };
}

// Dedicated OIDC boundary. No Access/user/CMS role can invoke these operations.
export async function handleSeoRunnerRequest(request: Request, env: AppEnv) {
  const match =
    /^\/seo-runner\/jobs\/([a-f0-9-]{36})(?:\/(claim|research|research-reject|review-reject|review|propose|publish|finish|skip|unresolved))?$/.exec(
      new URL(request.url).pathname,
    );
  if (!match) return json({ status: "not_found" }, 404);
  const operation = match[2] || "read";
  if (request.method !== (operation === "read" ? "GET" : "POST"))
    return json({ status: "method_not_allowed" }, 405);
  const identity = await authenticateRunner(request, env, true);
  const { job, run } = await authorizedJob(
    env,
    identity,
    match[1],
    operation === "read",
  );
  if (operation === "unresolved") {
    await markUnresolved(env, job.id);
    return json({ status: "unresolved" });
  }
  if (operation === "read")
    return json({
      job: {
        id: job.id,
        runId: run.run_id,
        deadline: run.deadline,
        status: job.status,
        nextStep: job.next_step,
        baseSha: job.base_sha,
      },
      candidate: JSON.parse(run.candidates_json)[job.candidate_index],
      policy: {
        siteId: identity.site.id,
        repository: identity.site.repository,
        baseBranch: identity.site.branch,
        packageDirectory: identity.site.packageDirectory,
        validationCommands: identity.site.validationCommands,
        draftOnly: true,
        protocolVersion: job.protocol_version,
        researchContract: job.research_contract,
      },
    });
  try {
    if (operation === "review-reject")
      return json(
        await finalizeReviewRejection(
          env,
          job,
          run,
          await readJsonObject(request),
        ),
      );
    if (operation === "research-reject")
      return json(
        await finalizeRejection(env, job, run, await readJsonObject(request)),
      );
    if (operation !== "finish") alive(run);
    if (operation === "skip") {
      if (job.status !== "inspecting") throw new Error("state");
      await skipJob(env, job);
      return json({ status: "skipped" });
    }
    if (operation === "claim")
      return json(
        await claimJob(
          env,
          job,
          run,
          identity,
          await readJsonObject(request, 1024 * 1024),
        ),
      );
    if (operation === "research" || operation === "review") {
      if (job.protocol_version !== 2 || !job.claim_recorded)
        throw new Error("state");
      const body = await readJsonObject(request, 1024 * 1024);
      const originalObject = await env.CMS_AI_IMAGES.get(
        baseKey(job) + "/source.json",
      );
      if (!originalObject) throw new Error("snapshot");
      const originals = await originalObject.json<EditorialFile[]>();
      const candidate: Candidate = JSON.parse(run.candidates_json)[
        job.candidate_index
      ];
      const article = sourceIdentity(candidate.site, candidate.url, originals);
      if (!article || article.articleKey !== job.article_key)
        throw new Error("identity");
      const context = checkContext(job, run);
      if (operation === "research") {
        if (
          job.status !== "claimed" ||
          job.next_step !== 0 ||
          Object.keys(body).length
        )
          throw new Error("state");
        try {
          return json({
            status: "researched",
            evidence: await researchArticle(env, context, article.source),
          });
        } catch (error) {
          if (
            job.research_contract === 2 &&
            error instanceof Error &&
            error.message === "seo_research_insufficient"
          )
            return json({
              status: "research_insufficient",
              offerSha256: await prepareRejection(
                env,
                context,
                article.source.content,
              ),
            });
          throw error;
        }
      }
      if (
        job.status !== "generated" ||
        job.next_step !== JSON.parse(job.paths_json!).length ||
        Object.keys(body).join() !== "files"
      )
        throw new Error("state");
      try {
        const receipt = await reviewArticle(
          env,
          context,
          article,
          originals,
          await snapshot(env, job),
          body.files as EditorialFile[],
        );
        return json({ status: "reviewed", receipt });
      } catch (error) {
        if (
          job.research_contract === 2 &&
          error instanceof Error &&
          error.message === "seo_ai_review_failed"
        )
          return json({
            status: "review_failed",
            offerSha256: await prepareReviewRejection(env, job, run),
          });
        throw error;
      }
    }
    if (operation === "propose")
      return json(
        await propose(
          env,
          job,
          run,
          await readJsonObject(request, 1024 * 1024),
        ),
      );
    if (operation === "publish") {
      const paths: string[] = JSON.parse(job.paths_json || "[]");
      if (job.status !== "generated" || job.next_step !== paths.length)
        throw new Error("generation_incomplete");
      if (job.protocol_version === 2) {
        const body = await readJsonObject(request);
        if (Object.keys(body).join() !== "filesSha256")
          throw new Error("seo_check_files");
        await assertReview(env, checkContext(job, run), body.filesSha256);
      }
      const changed = await env.CMS_AI_DB.prepare(
        "UPDATE seo_editorial_jobs SET status='publishing',publication_started=1 WHERE id=? AND status='generated'",
      )
        .bind(job.id)
        .run();
      if (changed.meta.changes !== 1) throw new Error("state");
      return json({ status: "publishing" });
    }
    const body = await readJsonObject(request);
    if (
      operation === "finish" &&
      job.status === "publishing" &&
      typeof body.prUrl === "string" &&
      new RegExp(
        "^https://github\\.com/" +
          identity.site.repository.replaceAll(".", "\\.") +
          "/pull/[1-9][0-9]*$",
      ).test(body.prUrl)
    ) {
      await env.CMS_AI_DB.batch([
        env.CMS_AI_DB.prepare(
          "UPDATE seo_editorial_jobs SET status='draft_pr' WHERE id=? AND status='publishing'",
        ).bind(job.id),
        env.CMS_AI_DB.prepare(
          "UPDATE seo_editorial_runs SET status='draft_pr',pr_url=? WHERE run_id=? AND job_id=? AND status='pending'",
        ).bind(body.prUrl, run.run_id, job.id),
      ]);
      return json(await editorialStatus(env, { runId: run.run_id }));
    }
    throw new Error("state");
  } catch (error) {
    await recordFailure(env, job, operation, error);
    await markUnresolved(env, job.id);
    return json({ status: "unresolved" });
  }
}

async function skipJob(env: AppEnv, job: EditorialJob) {
  const changed = await env.CMS_AI_DB.batch([
    env.CMS_AI_DB.prepare(
      "UPDATE seo_editorial_jobs SET status='ineligible' WHERE id=? AND status IN ('inspecting','claiming') AND claim_recorded=0",
    ).bind(job.id),
    env.CMS_AI_DB.prepare(
      "UPDATE seo_editorial_runs SET job_id=NULL,candidate_index=candidate_index+1 WHERE run_id=? AND job_id=? AND status='pending' AND EXISTS(SELECT 1 FROM seo_editorial_jobs WHERE id=? AND status='ineligible')",
    ).bind(job.run_id, job.id, job.id),
  ]);
  if (changed[1].meta.changes === 1) await advance(env, job.run_id);
}
async function claimJob(
  env: AppEnv,
  job: EditorialJob,
  run: Run,
  identity: RunnerIdentity,
  body: Record<string, unknown>,
) {
  if (
    job.status !== "inspecting" ||
    typeof body.baseSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(body.baseSha) ||
    body.baseSha !== identity.workflowSha
  )
    throw new Error("source_commit");
  const files = validateSourceFiles(identity.site, body.files);
  const candidate: Candidate = JSON.parse(run.candidates_json)[
    job.candidate_index
  ];
  const article = sourceIdentity(candidate.site, candidate.url, files);
  if (!article) {
    await skipJob(env, job);
    return { status: "skipped" };
  }
  const sourceHash = await sha256(normalizeLf(article.source.content));
  const paths = [
    article.source.path,
    ...article.translations.map((t) => t.path),
  ];
  // Local size estimates only: no evidence acquisition, lock or API reservation.
  // Keep legacy jobs on their original contract.
  let allocationHash: string | null = null;
  if (job.research_contract === 2) {
    const baseline = paths.map((path) => files.find((f) => f.path === path)!);
    const bytes = (request: unknown) =>
      new TextEncoder().encode(JSON.stringify(request)).length;
    const planBytes = bytes(
      buildPlanRequest(
        article.source.content,
        2,
        job.external_sources ? 4 : job.discovery_policy,
        job.external_sources
          ? externalScope(job.site_id, article.source)
          : undefined,
      ),
    );
    const reviewBytes = bytes(
      buildReviewRequest(article, files, baseline, {
        version: 1,
        checkedAt: "",
        sourceSha256: sourceHash,
        responseId: "not_acquired_size_estimate_only",
        queries: [],
        sources: [],
      }),
    );
    // Unknown future research/JA growth cannot be forecast. This placeholder is
    // explicitly unacquired and only rejects already oversized known inputs.
    const generationEstimateEvidence = {
      version: 1 as const,
      checkedAt: "",
      sourceSha256: sourceHash,
      responseId: "not_acquired_size_estimate_only",
      queries: [],
      sources: [],
    };
    const generationInputs = paths.map((path, step) => {
      const locale = article.translations.find((t) => t.path === path)?.locale;
      const knownFiles = files.filter(
        (f) =>
          f.path === article.source.path ||
          f.path === path ||
          f.path.startsWith("docs/"),
      );
      const instruction = buildEditorialInstruction({
        syntaxPolicy: job.generation_syntax,
        step,
        paths,
        locale,
        translationCount: article.translations.length,
        reason: candidate.reason,
        research: generationEstimateEvidence,
      });
      const request = buildSeoGenerationRequest(
        identity.site,
        article.source.path,
        [path],
        instruction,
        knownFiles,
      );
      return { path, locale: locale || "ja", bytes: bytes(request) };
    });
    let generationAllocation:
      ReturnType<typeof allocateGenerationInputs> | undefined;
    if (job.retrieval_contract === 2) {
      try {
        generationAllocation = allocateGenerationInputs(
          generationInputs,
          job.budget_version,
        );
      } catch {
        /* ineligible, no paid call */
      }
    }
    const monthJst = jstMonth(Date.now());
    const monthly =
      job.retrieval_contract === 2
        ? await env.CMS_AI_DB.prepare(
            "SELECT COALESCE(SUM(reserved_micros),0) AS held FROM seo_budget_calls WHERE month_jst=?",
          )
            .bind(monthJst)
            .first<{ held: number }>()
        : null;
    if (
      job.retrieval_contract === 2 &&
      (!monthly || !Number.isSafeInteger(monthly.held) || monthly.held < 0)
    )
      throw new Error("seo_budget_state_conflict");
    const reasons = [
      ...(monthly &&
      monthly.held + stageBudget(job.budget_version).maximum >
        monthBudgetMicros(monthJst)
        ? ["monthly_budget_insufficient"]
        : []),
      ...(planBytes > stageBudget(job.budget_version).limits.plan
        ? ["plan_input_exceeded"]
        : []),
      ...(reviewBytes > stageBudget(job.budget_version).limits.review
        ? ["baseline_review_input_exceeded"]
        : []),
      ...((
        job.retrieval_contract === 2
          ? !generationAllocation
          : generationInputs.some(
              (input) =>
                input.bytes > stageBudget(job.budget_version).limits.generation,
            )
      )
        ? ["baseline_generation_input_exceeded"]
        : []),
    ];
    const preflightRaw = JSON.stringify({
      version: 1,
      researchContract: 2,
      ...(job.generation_syntax === 2 ? { generationSyntax: 2 } : {}),
      ...(job.discovery_policy === 3
        ? { discoveryPolicy: job.external_sources ? 4 : 3 }
        : {}),
      ...(job.budget_version === 2 ? { budgetVersion: 2 } : {}),
      baseSha: body.baseSha,
      sourceSha256: sourceHash,
      sourceBundleSha256: await sha256(JSON.stringify(baseline)),
      knownInputBundleSha256: await sha256(JSON.stringify(files)),
      planBytes,
      reviewBytes,
      generationInputs,
      ...(generationAllocation
        ? { generationAllocation, retrievalContract: 2 }
        : {}),
      limits: {
        plan: stageBudget(job.budget_version).limits.plan,
        review: stageBudget(job.budget_version).limits.review,
        generation: stageBudget(job.budget_version).limits.generation,
        ...(job.budget_version === 2
          ? {
              generationPool: stageBudget(2).pool,
              maximumMicros: stageBudget(2).maximum,
              runMicros: stageBudget(2).runMicros,
            }
          : {}),
      },
      evidenceStatus: "not_acquired_size_estimate_only",
      reasons,
      status: reasons.length ? "ineligible" : "baseline_fits_not_reviewed",
    });
    const saved = await env.CMS_AI_IMAGES.put(
      baseKey(job) + "/eligibility-preflight.json",
      preflightRaw,
      { onlyIf: { etagDoesNotMatch: "*" } },
    );
    if (!saved) throw new Error("snapshot");
    allocationHash =
      job.retrieval_contract === 2 ? await sha256(preflightRaw) : null;
    if (reasons.length) {
      await skipJob(env, job);
      return { status: "skipped" };
    }
  }
  const changed = await env.CMS_AI_DB.prepare(
    "UPDATE seo_editorial_jobs SET status='claiming',source_sha256=?,base_sha=?,article_key=?,article_path=?,paths_json=?,input_allocation_sha256=? WHERE id=? AND status='inspecting'",
  )
    .bind(
      sourceHash,
      body.baseSha,
      article.articleKey,
      article.source.path,
      JSON.stringify(paths),
      allocationHash,
      job.id,
    )
    .run();
  if (changed.meta.changes !== 1) throw new Error("state");
  const stored = await env.CMS_AI_IMAGES.put(
    baseKey(job) + "/source.json",
    JSON.stringify(files),
    { onlyIf: { etagDoesNotMatch: "*" } },
  );
  if (!stored) throw new Error("snapshot");
  alive(run);
  const claim = await env.SEO_COORDINATOR!.claim({
    runId: run.run_id,
    articleKey: article.articleKey,
    sourceSha256: sourceHash,
  });
  if (claim.status !== "claimed") {
    await skipJob(env, (await jobRow(env, job.id))!);
    return { status: "skipped" };
  }
  await env.CMS_AI_DB.batch([
    env.CMS_AI_DB.prepare(
      "UPDATE seo_editorial_jobs SET status='claimed',claim_recorded=1 WHERE id=? AND status='claiming'",
    ).bind(job.id),
    env.CMS_AI_DB.prepare(
      "UPDATE seo_editorial_runs SET article_key=? WHERE run_id=? AND job_id=? AND status='pending'",
    ).bind(article.articleKey, run.run_id, job.id),
  ]);
  return { status: "claimed", paths, articleKey: article.articleKey };
}

function checkContext(job: EditorialJob, run: Run): CheckContext {
  return {
    jobId: job.id,
    runId: run.run_id,
    budgetRunId: run.budget_run_id,
    articleKey: job.article_key!,
    budgetArticleKey: job.site_id + ":" + job.article_path,
    sourceSha256: job.source_sha256!,
    deadline: run.deadline,
    contractVersion: job.research_contract,
    retrievalVersion: job.retrieval_contract,
    budgetVersion: job.budget_version,
    discoveryPolicy: job.external_sources ? 4 : job.discovery_policy,
    ...(job.external_sources ? { siteId: job.site_id } : {}),
  };
}

async function snapshot(env: AppEnv, job: EditorialJob) {
  const original = await env.CMS_AI_IMAGES.get(baseKey(job) + "/source.json");
  if (!original) throw new Error("snapshot");
  const files: EditorialFile[] = await original.json();
  for (let i = 0; i < job.next_step; i++) {
    const object = await env.CMS_AI_IMAGES.get(
      baseKey(job) + "/step-" + i + ".json",
    );
    if (!object) throw new Error("snapshot");
    const file: EditorialFile = await object.json();
    const index = files.findIndex((f) => f.path === file.path);
    if (index < 0) throw new Error("snapshot");
    files[index] = file;
  }
  if (job.next_step > 1) {
    const formatted = await env.CMS_AI_IMAGES.get(
      baseKey(job) + "/formatted-ja.json",
    );
    if (!formatted) throw new Error("snapshot");
    const source: EditorialFile = await formatted.json();
    const index = files.findIndex((f) => f.path === source.path);
    if (index < 0) throw new Error("snapshot");
    files[index] = source;
  }
  return files;
}
async function propose(
  env: AppEnv,
  job: EditorialJob,
  run: Run,
  body: Record<string, unknown>,
) {
  if (
    !job.claim_recorded ||
    !["claimed", "generated"].includes(job.status) ||
    body.step !== job.next_step ||
    Object.keys(body).some((key) => key !== "step" && key !== "japanese")
  )
    throw new Error("state");
  const paths: string[] = JSON.parse(job.paths_json!);
  const path = paths[job.next_step];
  if (!path) throw new Error("state");
  const files = await snapshot(env, job);
  // Accept target-repository formatting only if metadata and the GFM AST match.
  if (job.next_step === 1) {
    if (typeof body.japanese !== "string")
      throw new Error("format_source_missing");
    const source = files.find((file) => file.path === job.article_path)!;
    assertFormattedSource(source.content, body.japanese);
    source.content = normalizeLf(body.japanese);
  } else if (body.japanese !== undefined)
    throw new Error("format_source_unexpected");
  const candidate: Candidate = JSON.parse(run.candidates_json)[
    job.candidate_index
  ];
  const article = sourceIdentity(candidate.site, candidate.url, files)!;
  if (!article || article.articleKey !== job.article_key)
    throw new Error("identity");
  const original = files.find((file) => file.path === path)!;
  const japanese = files.find(
    (file) => file.path === job.article_path,
  )!.content;
  const locale = article.translations.find((t) => t.path === path)?.locale;
  const context = files.filter(
    (f) =>
      f.path === job.article_path ||
      f.path === path ||
      f.path.startsWith("docs/"),
  );
  const research =
    job.protocol_version === 2
      ? await loadResearch(env, checkContext(job, run))
      : null;
  let generationInputCap: number | undefined;
  if (job.retrieval_contract === 2) {
    const object = await env.CMS_AI_IMAGES.get(
      baseKey(job) + "/eligibility-preflight.json",
    );
    const raw = object ? await object.text() : null;
    if (
      !raw ||
      !job.input_allocation_sha256 ||
      (await sha256(raw)) !== job.input_allocation_sha256
    )
      throw new Error("seo_check_evidence");
    const saved = JSON.parse(raw);
    if (
      !saved ||
      saved.retrievalContract !== 2 ||
      (saved.budgetVersion ?? 1) !== job.budget_version ||
      (saved.discoveryPolicy ?? 2) !==
        (job.external_sources ? 4 : job.discovery_policy) ||
      (saved.generationSyntax ?? 1) !== job.generation_syntax ||
      saved.sourceSha256 !== job.source_sha256 ||
      saved.baseSha !== job.base_sha ||
      JSON.stringify(saved.generationAllocation?.map((x: any) => x.path)) !==
        JSON.stringify(paths)
    )
      throw new Error("seo_check_evidence");
    assertGenerationAllocation(saved.generationAllocation, job.budget_version);
    generationInputCap = saved.generationAllocation[job.next_step].maxBytes;
  }
  const callId = "seo-" + crypto.randomUUID();
  const changed = await env.CMS_AI_DB.prepare(
    "UPDATE seo_editorial_jobs SET status='generating',generation_started=1,call_id=? WHERE id=? AND status IN ('claimed','generated') AND next_step=?",
  )
    .bind(callId, job.id, job.next_step)
    .run();
  if (changed.meta.changes !== 1) throw new Error("state");
  const generated = await generateSeo(env, {
    runId: run.budget_run_id,
    budgetVersion: job.budget_version,
    callId,
    deadline: run.deadline,
    siteId: job.site_id,
    articlePath: job.article_path,
    allowedPaths: [path],
    files: context,
    ...(research ? { researchBudget: true } : {}),
    ...(generationInputCap !== undefined ? { generationInputCap } : {}),
    instruction: buildEditorialInstruction({
      syntaxPolicy: job.generation_syntax,
      step: job.next_step,
      paths,
      locale,
      translationCount: article.translations.length,
      reason: candidate.reason,
      research,
    }),
  });
  alive(run);
  if (
    generated.status !== "proposal_created" ||
    generated.result.changes.length !== 1 ||
    generated.result.changes[0].path !== path
  )
    throw new Error("generation");
  const content = await acceptEditorialChange(
    article,
    original,
    generated.result.changes[0],
    locale ? japanese : null,
    Date.now(),
    research ? evidenceReferences(research) : [],
    job.generation_syntax,
  );
  if (job.next_step === 1) {
    // Persist formatting before later locales read the accepted Japanese source.
    const saved = await env.CMS_AI_IMAGES.put(
      baseKey(job) + "/formatted-ja.json",
      JSON.stringify({ path: job.article_path, content: japanese }),
      { onlyIf: { etagDoesNotMatch: "*" } },
    );
    if (!saved) throw new Error("snapshot");
  }
  const saved = await env.CMS_AI_IMAGES.put(
    baseKey(job) + "/step-" + job.next_step + ".json",
    JSON.stringify({ path, content }),
    { onlyIf: { etagDoesNotMatch: "*" } },
  );
  if (!saved) throw new Error("snapshot");
  if (job.research_contract === 2) {
    const proposal = await env.CMS_AI_IMAGES.get(
      "seo-proposals/" + callId + ".json",
    );
    if (!proposal) throw new Error("snapshot");
    await immutableReviewObject(
      env,
      baseKey(job) + "/step-" + job.next_step + "-call.json",
      {
        step: job.next_step,
        path,
        callId,
        proposalSha256: await sha256(await proposal.text()),
        acceptedSha256: await sha256(JSON.stringify({ path, content })),
      },
    );
  }
  const finished = await env.CMS_AI_DB.prepare(
    "UPDATE seo_editorial_jobs SET status='generated',next_step=next_step+1 WHERE id=? AND status='generating' AND call_id=?",
  )
    .bind(job.id, callId)
    .run();
  if (finished.meta.changes !== 1) throw new Error("state");
  return {
    status: "proposal_created",
    file: { path, content },
    nextStep: job.next_step + 1,
  };
}
