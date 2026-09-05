import { authenticateSiteRequest, type SiteIdentity } from "./auth.ts";
import {
  createJob,
  getConversation,
  getJob,
  listConversations,
  updateJob,
} from "./db.ts";
import type { AppEnv } from "./env.ts";
import { dispatchCmsAiJob } from "./github.ts";
import {
  assertSameOrigin,
  HttpError,
  json,
  methodNotAllowed,
  requiredText,
} from "./http.ts";
import { canEdit, parseReasoningEffort, type Job } from "./models.ts";
import {
  boundedRequest,
  deleteImages,
  imageResponse,
  storeImages,
  validateImages,
} from "./images.ts";

const PREFIX = "/admin/api/ai/";
const PENDING_STATUSES = new Set(["queued", "running", "validating"]);

export async function handleUserRequest(request: Request, env: AppEnv) {
  const route = parseRoute(new URL(request.url).pathname);

  if (!route) return json({ message: "CMS AIのURLを確認してください。" }, 404);

  const identity = await authenticateSiteRequest(request, env);

  if (route.kind === "image") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const job = await getJob(env, route.jobId);
    if (
      !job ||
      job.siteId !== identity.site.id ||
      job.requestedBy !== identity.email
    ) {
      throw new HttpError(404, "画像が見つかりません。");
    }
    return await imageResponse(env, job, route.imageId);
  }

  if (route.kind === "session") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return sessionResponse(request, identity);
  }

  if (route.kind === "jobs") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return await startConversation(request, env, identity);
  }

  if (route.kind === "job") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return await readJob(env, identity, route.jobId);
  }

  if (route.kind === "conversations") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return await readConversationList(env, identity);
  }

  if (route.kind === "conversation") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return await readConversation(env, identity, route.conversationId);
  }

  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  return await continueConversation(
    request,
    env,
    identity,
    route.conversationId,
  );
}

async function startConversation(
  request: Request,
  env: AppEnv,
  identity: SiteIdentity,
) {
  assertSameOrigin(request);
  const input = await readMessageInput(request);
  const job = await createMessageJob(env, identity, input);

  await dispatchOrFail(env, identity, job);
  return json({ job: serializeJob(job) }, 202);
}

async function continueConversation(
  request: Request,
  env: AppEnv,
  identity: SiteIdentity,
  conversationId: string,
) {
  assertSameOrigin(request);
  const jobs = await getConversation(
    env,
    identity.site.id,
    conversationId,
    identity.email,
  );

  if (jobs.length === 0) {
    throw new HttpError(404, "この会話が見つかりません。");
  }

  const latest = jobs.at(-1)!;

  if (PENDING_STATUSES.has(latest.status)) {
    throw new HttpError(
      409,
      "前のメッセージを処理中です。完了をお待ちください。",
    );
  }

  if (latest.status === "merged") {
    throw new HttpError(409, "マージ済みです。新しい会話を開始してください。");
  }

  const input = await readMessageInput(request);
  const job = await createMessageJob(env, identity, input, conversationId);

  await dispatchOrFail(env, identity, job);
  const conversation = await getConversation(
    env,
    identity.site.id,
    conversationId,
    identity.email,
  );

  return json({ conversation: serializeConversation(conversation) }, 202);
}

async function dispatchOrFail(env: AppEnv, identity: SiteIdentity, job: Job) {
  try {
    await dispatchCmsAiJob(env, identity.site, job);
  } catch (error) {
    await updateJob(env, job.id, {
      errorMessage:
        error instanceof Error
          ? error.message
          : "GitHub Actionsを開始できませんでした。",
      status: "failed",
      summary: "CMS AIの実行を開始できませんでした。",
    });
    throw error;
  }
}

async function createMessageJob(
  env: AppEnv,
  identity: SiteIdentity,
  input: Awaited<ReturnType<typeof readMessageInput>>,
  conversationId?: string,
) {
  const id = crypto.randomUUID();
  await storeImages(env, id, input.images);
  try {
    return await createJob(env, {
      id,
      attachments: input.images.map((image) => image.attachment),
      conversationId,
      instruction: input.instruction,
      reasoningEffort: input.reasoningEffort,
      requestedBy: identity.email,
      requestedRole: identity.membership.role,
      siteId: identity.site.id,
    });
  } catch (error) {
    await deleteImages(env, id, input.images);
    throw error;
  }
}

async function readJob(env: AppEnv, identity: SiteIdentity, jobId: string) {
  const job = await getJob(env, jobId);

  if (
    !job ||
    job.siteId !== identity.site.id ||
    job.requestedBy !== identity.email
  ) {
    throw new HttpError(404, "CMS AIジョブが見つかりません。");
  }

  return json({ job: serializeJob(job) });
}

async function readConversationList(env: AppEnv, identity: SiteIdentity) {
  const conversations = await listConversations(
    env,
    identity.site.id,
    identity.email,
  );

  return json({
    conversations: conversations.map(serializeConversationSummary),
  });
}

async function readConversation(
  env: AppEnv,
  identity: SiteIdentity,
  conversationId: string,
) {
  const jobs = await getConversation(
    env,
    identity.site.id,
    conversationId,
    identity.email,
  );

  if (jobs.length === 0) {
    throw new HttpError(404, "この会話が見つかりません。");
  }

  return json({ conversation: serializeConversation(jobs) });
}

function sessionResponse(request: Request, identity: SiteIdentity) {
  const redirect = safeRedirect(
    new URL(request.url).searchParams.get("redirect") || "",
  );

  if (redirect) {
    return new Response(null, {
      headers: { "Cache-Control": "no-store", Location: redirect },
      status: 302,
    });
  }

  return json({
    capabilities: {
      edit: canEdit(identity.membership.role),
      manage: identity.membership.role === "admin",
    },
    role: identity.membership.role,
    site: {
      displayName: identity.site.displayName,
      id: identity.site.id,
    },
  });
}

function serializeJob(job: Job) {
  return {
    attachments: job.attachments.map((attachment) => ({
      ...attachment,
      url: `${PREFIX}jobs/${job.id}/images/${attachment.id}`,
    })),
    assistantMessage: job.assistantMessage,
    changedPaths: job.changedPaths,
    clarification: job.clarification,
    conversationId: job.conversationId,
    createdAt: job.createdAt,
    errorMessage: job.errorMessage,
    id: job.id,
    instruction: job.instruction,
    prUrl: job.prUrl,
    reasoningEffort: job.reasoningEffort,
    status: job.status,
    summary: job.summary,
    turnNumber: job.turnNumber,
    updatedAt: job.updatedAt,
  };
}

function serializeConversation(jobs: Job[]) {
  const latest = jobs.at(-1)!;

  return {
    id: latest.conversationId,
    jobs: jobs.map(serializeJob),
    reasoningEffort: latest.reasoningEffort,
    status: latest.status,
    title: conversationTitle(jobs[0]?.instruction || ""),
    updatedAt: latest.updatedAt,
  };
}

function serializeConversationSummary(jobs: Job[]) {
  const conversation = serializeConversation(jobs);

  return {
    id: conversation.id,
    status: conversation.status,
    title: conversation.title,
    turnCount: jobs.length,
    updatedAt: conversation.updatedAt,
  };
}

export async function readMessageInput(request: Request) {
  const contentType = request.headers.get("Content-Type") || "";
  const bounded = await boundedRequest(request);
  const files: File[] = [];
  let instruction: unknown;
  let reasoningEffort: unknown;

  if (
    contentType.includes("multipart/form-data") ||
    contentType.includes("application/x-www-form-urlencoded")
  ) {
    const form = await bounded.formData().catch(() => {
      throw new HttpError(400, "入力形式を確認してください。");
    });

    for (const [key, value] of form) {
      if (typeof value !== "string") {
        if (key !== "images")
          throw new HttpError(400, "添付形式を確認してください。");
        files.push(value);
      } else if (key === "images") {
        throw new HttpError(
          400,
          "画像はファイルで添付してください。URL指定はできません。",
        );
      }
    }

    instruction = form.get("instruction");
    reasoningEffort = form.get("reasoningEffort");
  } else if (contentType.includes("application/json")) {
    const body: unknown = await bounded.json().catch(() => null);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "入力形式を確認してください。");
    }

    instruction = (body as Record<string, unknown>).instruction;
    reasoningEffort = (body as Record<string, unknown>).reasoningEffort;
    if ("images" in body || "attachments" in body)
      throw new HttpError(400, "画像はファイルで添付してください。");
  } else {
    throw new HttpError(415, "入力形式を確認してください。");
  }

  const images = await validateImages(files);
  return {
    images,
    instruction:
      images.length &&
      (instruction === null || instruction === undefined || instruction === "")
        ? "添付画像について説明してください。"
        : requiredText(instruction, 4_000),
    reasoningEffort: parseReasoningEffort(reasoningEffort),
  };
}

function conversationTitle(instruction: string) {
  const oneLine = instruction.replace(/\s+/g, " ").trim();

  return oneLine.length > 54 ? oneLine.slice(0, 53) + "…" : oneLine;
}

function safeRedirect(value: string) {
  return value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\")
    ? value
    : "";
}

function parseRoute(pathname: string) {
  if (!pathname.startsWith(PREFIX)) return null;
  const parts = pathname.slice(PREFIX.length).split("/").filter(Boolean);

  if (parts.length === 4 && parts[0] === "jobs" && parts[2] === "images") {
    return { kind: "image" as const, jobId: parts[1], imageId: parts[3] };
  }

  if (parts.length === 1 && parts[0] === "session") {
    return { kind: "session" as const };
  }
  if (parts.length === 1 && parts[0] === "jobs") {
    return { kind: "jobs" as const };
  }
  if (parts.length === 2 && parts[0] === "jobs") {
    return { jobId: parts[1], kind: "job" as const };
  }
  if (parts.length === 1 && parts[0] === "conversations") {
    return { kind: "conversations" as const };
  }
  if (parts.length === 2 && parts[0] === "conversations") {
    return { conversationId: parts[1], kind: "conversation" as const };
  }
  if (
    parts.length === 3 &&
    parts[0] === "conversations" &&
    parts[2] === "messages"
  ) {
    return { conversationId: parts[1], kind: "messages" as const };
  }

  return null;
}
