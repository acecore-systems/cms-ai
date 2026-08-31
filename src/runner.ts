import { getConversation, getJob, updateJob } from "./db.ts";
import type { AppEnv } from "./env.ts";
import {
  HttpError,
  json,
  methodNotAllowed,
  optionalText,
  readJsonObject,
  requiredText,
} from "./http.ts";
import { runInference } from "./inference.ts";
import { JOB_STATUSES, type Job, type JobStatus } from "./models.ts";
import { authenticateRunner, type RunnerIdentity } from "./oidc.ts";
import { isSiteWritablePath, normalizeRepositoryPath } from "./sites.ts";

const PREFIX = "/runner/";
const RUNNER_STATUSES = new Set<JobStatus>([
  "running",
  "validating",
  "responded",
  "failed",
  "pr_created",
]);
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  failed: [],
  merged: [],
  pr_created: [],
  queued: ["running", "failed"],
  responded: [],
  running: ["running", "validating", "responded", "failed"],
  validating: ["running", "validating", "pr_created", "failed"],
};

export async function handleRunnerRequest(request: Request, env: AppEnv) {
  const route = parseRoute(new URL(request.url).pathname);

  if (!route) {
    return json({ message: "CMS AI runnerのURLを確認してください。" }, 404);
  }

  const identity = await authenticateRunner(request, env);

  if (route.kind === "job") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return await readRunnerJob(env, identity, route.jobId);
  }

  if (route.kind === "inference") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return await executeInference(request, env, identity);
  }

  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  return await updateRunnerStatus(request, env, identity, route.jobId);
}

async function readRunnerJob(
  env: AppEnv,
  identity: RunnerIdentity,
  jobId: string,
) {
  const job = await getAuthorizedJob(env, identity, jobId);

  return json({
    job: {
      branchName: job.branchName,
      conversationId: job.conversationId,
      id: job.id,
      instruction: job.instruction,
      prUrl: job.prUrl,
      reasoningEffort: job.reasoningEffort,
      requestedRole: job.requestedRole,
      status: job.status,
      turnNumber: job.turnNumber,
    },
    policy: {
      autoMergeEnabled: false,
      baseBranch: identity.site.branch,
      canonicalUrl: identity.site.canonicalUrl,
      packageDirectory: identity.site.packageDirectory,
      projectRoot: identity.site.projectRoot,
      repository: identity.site.repository,
      sourcePrefixes: identity.site.sourcePrefixes,
      validationCommands: identity.site.validationCommands,
      writablePrefixes: identity.site.writablePrefixes,
    },
  });
}

async function executeInference(
  request: Request,
  env: AppEnv,
  identity: RunnerIdentity,
) {
  const body = await readJsonObject(request, 2 * 1024 * 1024);
  const jobId = requiredText(body.jobId, 64);
  const job = await getAuthorizedJob(env, identity, jobId);

  if (!["queued", "running", "validating"].includes(job.status)) {
    throw new HttpError(409, "このCMS AIジョブは実行できません。");
  }

  const validationFeedback = optionalText(body.validationFeedback, 12_000);
  const conversationJobs = await getConversation(
    env,
    job.siteId,
    job.conversationId,
    job.requestedBy,
  );

  await updateJob(env, job.id, {
    errorMessage: null,
    status: "running",
    summary: "AIが会話と関連ソースを確認しています。",
  });

  const result = await runInference(
    env,
    identity.site,
    job,
    body.files as unknown,
    conversationJobs,
    validationFeedback || undefined,
  );

  if (result.changes.length === 0) {
    const assistantMessage =
      result.clarification || result.summary || "内容を確認しました。";

    await updateJob(env, job.id, {
      assistantMessage,
      clarification: result.clarification,
      status: "responded",
      summary: result.summary,
    });

    return json({ result, status: "responded" });
  }

  await updateJob(env, job.id, {
    assistantMessage: result.summary,
    clarification: null,
    status: "running",
    summary: result.summary,
  });

  return json({ result, status: "running" });
}

async function updateRunnerStatus(
  request: Request,
  env: AppEnv,
  identity: RunnerIdentity,
  jobId: string,
) {
  const job = await getAuthorizedJob(env, identity, jobId);
  const body = await readJsonObject(request);
  const status = parseRunnerStatus(body.status);

  if (!TRANSITIONS[job.status].includes(status)) {
    throw new HttpError(409, "CMS AIジョブの状態遷移を確認してください。");
  }

  const update: Parameters<typeof updateJob>[2] = { status };

  if ("assistantMessage" in body) {
    update.assistantMessage = optionalText(body.assistantMessage, 4_000);
  }
  if ("clarification" in body) {
    update.clarification = optionalText(body.clarification, 4_000);
  }
  if ("errorMessage" in body) {
    update.errorMessage = optionalText(body.errorMessage, 2_000);
  }
  if ("summary" in body) {
    update.summary = optionalText(body.summary, 4_000);
  }
  if ("changedPaths" in body) {
    update.changedPaths = parseChangedPaths(identity, body.changedPaths);
  }
  if ("prUrl" in body) {
    update.prUrl = parsePullRequestUrl(identity, body.prUrl);
  }

  const updated = await updateJob(env, job.id, update);

  return json({ job: { id: updated.id, status: updated.status } });
}

async function getAuthorizedJob(
  env: AppEnv,
  identity: RunnerIdentity,
  jobId: string,
) {
  const job = await getJob(env, jobId);

  if (!job) throw new HttpError(404, "CMS AIジョブが見つかりません。");
  if (job.siteId !== identity.site.id) {
    throw new HttpError(403, "このCMS AIジョブは実行できません。");
  }

  return job;
}

function parseRunnerStatus(value: unknown) {
  if (
    typeof value !== "string" ||
    !JOB_STATUSES.includes(value as JobStatus) ||
    !RUNNER_STATUSES.has(value as JobStatus)
  ) {
    throw new HttpError(400, "CMS AIジョブの状態を確認してください。");
  }

  return value as JobStatus;
}

function parseChangedPaths(identity: RunnerIdentity, value: unknown) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new HttpError(400, "CMS AIの変更ファイルを確認してください。");
  }

  const result = value.map((item) => {
    if (typeof item !== "string") {
      throw new HttpError(400, "CMS AIの変更ファイルを確認してください。");
    }

    const path = normalizeRepositoryPath(item);

    if (!path || !isSiteWritablePath(identity.site, path)) {
      throw new HttpError(400, "CMS AIの変更範囲を確認してください。");
    }

    return path;
  });

  return Array.from(new Set(result));
}

function parsePullRequestUrl(identity: RunnerIdentity, value: unknown) {
  if (value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "Pull RequestのURLを確認してください。");
  }

  try {
    const url = new URL(value);
    const expectedPrefix = `/${identity.site.repository}/pull/`;

    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      !url.pathname.startsWith(expectedPrefix) ||
      !/^\d+$/.test(url.pathname.slice(expectedPrefix.length)) ||
      url.search ||
      url.hash
    ) {
      throw new Error("unexpected Pull Request URL");
    }

    return url.toString();
  } catch {
    throw new HttpError(400, "Pull RequestのURLを確認してください。");
  }
}

function parseRoute(pathname: string) {
  if (!pathname.startsWith(PREFIX)) return null;
  const parts = pathname.slice(PREFIX.length).split("/").filter(Boolean);

  if (parts.length === 2 && parts[0] === "jobs") {
    return { jobId: parts[1], kind: "job" as const };
  }
  if (parts.length === 1 && parts[0] === "inference") {
    return { kind: "inference" as const };
  }
  if (parts.length === 3 && parts[0] === "jobs" && parts[2] === "status") {
    return { jobId: parts[1], kind: "status" as const };
  }

  return null;
}
