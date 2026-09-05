import type { AppEnv } from "./env.ts";
import { HttpError } from "./http.ts";
import {
  JOB_STATUSES,
  REASONING_EFFORTS,
  ROLES,
  type Job,
  type ImageAttachment,
  type JobStatus,
  type Membership,
  type ReasoningEffort,
  type Role,
} from "./models.ts";

type MembershipRow = {
  created_at: string;
  created_by: string;
  enabled: number;
  principal_email: string;
  role: string;
  site_id: string;
  updated_at: string;
};

type JobRow = {
  attachments_json: string;
  assistant_message: string | null;
  branch_name: string;
  changed_paths_json: string;
  clarification: string | null;
  conversation_id: string;
  created_at: string;
  error_message: string | null;
  id: string;
  instruction: string;
  pr_url: string | null;
  reasoning_effort: string;
  requested_by: string;
  requested_role: string;
  site_id: string;
  status: string;
  summary: string | null;
  turn_number: number;
  updated_at: string;
};

const JOB_COLUMNS = [
  "id, site_id, conversation_id, turn_number, requested_by, requested_role,",
  "instruction, reasoning_effort, status, branch_name, assistant_message,",
  "summary, clarification, pr_url, changed_paths_json, error_message,",
  "created_at, updated_at, attachments_json",
].join(" ");

export async function getMembership(
  env: AppEnv,
  siteId: string,
  principalEmail: string,
) {
  const row = await env.CMS_AI_DB.prepare(
    [
      "SELECT site_id, principal_email, role, enabled, created_by, created_at, updated_at",
      "FROM cms_ai_memberships",
      "WHERE site_id = ? AND principal_email = ? LIMIT 1",
    ].join(" "),
  )
    .bind(siteId, principalEmail)
    .first<MembershipRow>();

  return row ? parseMembership(row) : null;
}

export async function listMemberships(env: AppEnv, siteId: string) {
  const result = await env.CMS_AI_DB.prepare(
    [
      "SELECT site_id, principal_email, role, enabled, created_by, created_at, updated_at",
      "FROM cms_ai_memberships WHERE site_id = ?",
      "ORDER BY principal_email ASC LIMIT 500",
    ].join(" "),
  )
    .bind(siteId)
    .all<MembershipRow>();

  return result.results.map(parseMembership);
}

export async function countEnabledAdmins(env: AppEnv, siteId: string) {
  const row = await env.CMS_AI_DB.prepare(
    [
      "SELECT COUNT(*) AS count FROM cms_ai_memberships",
      "WHERE site_id = ? AND role = 'admin' AND enabled = 1",
    ].join(" "),
  )
    .bind(siteId)
    .first<{ count: number }>();

  return Number(row?.count || 0);
}

export async function setMembership(
  env: AppEnv,
  input: {
    actorEmail: string;
    principalEmail: string;
    role: Role;
    siteId: string;
  },
) {
  const current = await getMembership(env, input.siteId, input.principalEmail);
  const now = new Date().toISOString();
  const action = current ? "change" : "grant";

  await env.CMS_AI_DB.batch([
    env.CMS_AI_DB.prepare(
      [
        "INSERT INTO cms_ai_memberships",
        "(site_id, principal_email, role, enabled, created_by, created_at, updated_at)",
        "VALUES (?, ?, ?, 1, ?, ?, ?)",
        "ON CONFLICT(site_id, principal_email) DO UPDATE SET",
        "role = excluded.role, enabled = 1, updated_at = excluded.updated_at",
      ].join(" "),
    ).bind(
      input.siteId,
      input.principalEmail,
      input.role,
      input.actorEmail,
      now,
      now,
    ),
    env.CMS_AI_DB.prepare(
      [
        "INSERT INTO cms_ai_permission_audit",
        "(id, actor_email, action, site_id, principal_email, previous_role, next_role, created_at)",
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ].join(" "),
    ).bind(
      crypto.randomUUID(),
      input.actorEmail,
      action,
      input.siteId,
      input.principalEmail,
      current?.role || null,
      input.role,
      now,
    ),
  ]);

  return {
    createdAt: current?.createdAt || now,
    createdBy: current?.createdBy || input.actorEmail,
    enabled: true,
    principalEmail: input.principalEmail,
    role: input.role,
    siteId: input.siteId,
    updatedAt: now,
  } satisfies Membership;
}

export async function revokeMembership(
  env: AppEnv,
  input: {
    actorEmail: string;
    principalEmail: string;
    siteId: string;
  },
) {
  const current = await getMembership(env, input.siteId, input.principalEmail);

  if (!current || !current.enabled) return false;

  const now = new Date().toISOString();

  await env.CMS_AI_DB.batch([
    env.CMS_AI_DB.prepare(
      [
        "UPDATE cms_ai_memberships SET enabled = 0, updated_at = ?",
        "WHERE site_id = ? AND principal_email = ?",
      ].join(" "),
    ).bind(now, input.siteId, input.principalEmail),
    env.CMS_AI_DB.prepare(
      [
        "INSERT INTO cms_ai_permission_audit",
        "(id, actor_email, action, site_id, principal_email, previous_role, next_role, created_at)",
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ].join(" "),
    ).bind(
      crypto.randomUUID(),
      input.actorEmail,
      "revoke",
      input.siteId,
      input.principalEmail,
      current.role,
      null,
      now,
    ),
  ]);

  return true;
}

export async function createJob(
  env: AppEnv,
  input: {
    id?: string;
    attachments?: ImageAttachment[];
    conversationId?: string;
    instruction: string;
    reasoningEffort: ReasoningEffort;
    requestedBy: string;
    requestedRole: Role;
    siteId: string;
  },
) {
  const id = input.id || crypto.randomUUID();
  assertId(id);
  const conversationId = input.conversationId || id;
  const existingJobs = input.conversationId
    ? await getConversation(
        env,
        input.siteId,
        conversationId,
        input.requestedBy,
      )
    : [];

  if (input.conversationId && existingJobs.length === 0) {
    throw new HttpError(404, "この会話が見つかりません。");
  }

  const turnNumber = existingJobs.length + 1;

  if (turnNumber > 30) {
    throw new HttpError(
      409,
      "この会話は上限に達しました。新しい会話を開始してください。",
    );
  }

  const branchName = "ai/cms-" + conversationId;
  const existingPrUrl =
    existingJobs.findLast((job) => job.prUrl)?.prUrl || null;
  const now = new Date().toISOString();

  try {
    await env.CMS_AI_DB.prepare(
      [
        "INSERT INTO cms_ai_jobs",
        "(id, site_id, conversation_id, turn_number, requested_by, requested_role,",
        "instruction, reasoning_effort, status, branch_name, changed_paths_json,",
        "pr_url, created_at, updated_at, attachments_json)",
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ].join(" "),
    )
      .bind(
        id,
        input.siteId,
        conversationId,
        turnNumber,
        input.requestedBy,
        input.requestedRole,
        input.instruction,
        input.reasoningEffort,
        "queued",
        branchName,
        "[]",
        existingPrUrl,
        now,
        now,
        JSON.stringify(input.attachments || []),
      )
      .run();
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed/i.test(error.message)
    ) {
      throw new HttpError(
        409,
        "同じ会話へ別のメッセージを処理中です。完了をお待ちください。",
      );
    }

    throw error;
  }

  return {
    attachments: input.attachments || [],
    assistantMessage: null,
    branchName,
    changedPaths: [],
    clarification: null,
    conversationId,
    createdAt: now,
    errorMessage: null,
    id,
    instruction: input.instruction,
    prUrl: existingPrUrl,
    reasoningEffort: input.reasoningEffort,
    requestedBy: input.requestedBy,
    requestedRole: input.requestedRole,
    siteId: input.siteId,
    status: "queued",
    summary: null,
    turnNumber,
    updatedAt: now,
  } satisfies Job;
}

export async function getJob(env: AppEnv, jobId: string) {
  assertId(jobId);
  const row = await env.CMS_AI_DB.prepare(
    `SELECT ${JOB_COLUMNS} FROM cms_ai_jobs WHERE id = ? LIMIT 1`,
  )
    .bind(jobId)
    .first<JobRow>();

  return row ? parseJob(row) : null;
}

export async function getConversation(
  env: AppEnv,
  siteId: string,
  conversationId: string,
  requestedBy?: string,
) {
  assertId(conversationId);
  const statement = requestedBy
    ? env.CMS_AI_DB.prepare(
        [
          `SELECT ${JOB_COLUMNS} FROM cms_ai_jobs`,
          "WHERE site_id = ? AND conversation_id = ? AND requested_by = ?",
          "ORDER BY turn_number ASC LIMIT 30",
        ].join(" "),
      ).bind(siteId, conversationId, requestedBy)
    : env.CMS_AI_DB.prepare(
        [
          `SELECT ${JOB_COLUMNS} FROM cms_ai_jobs`,
          "WHERE site_id = ? AND conversation_id = ?",
          "ORDER BY turn_number ASC LIMIT 30",
        ].join(" "),
      ).bind(siteId, conversationId);
  const result = await statement.all<JobRow>();

  return result.results.map(parseJob);
}

export async function listConversations(
  env: AppEnv,
  siteId: string,
  requestedBy: string,
) {
  const result = await env.CMS_AI_DB.prepare(
    [
      `SELECT ${JOB_COLUMNS} FROM cms_ai_jobs`,
      "WHERE site_id = ? AND requested_by = ?",
      "ORDER BY created_at DESC LIMIT 200",
    ].join(" "),
  )
    .bind(siteId, requestedBy)
    .all<JobRow>();
  const grouped = new Map<string, Job[]>();

  for (const row of result.results) {
    const job = parseJob(row);
    const jobs = grouped.get(job.conversationId) || [];
    jobs.push(job);
    grouped.set(job.conversationId, jobs);
  }

  return Array.from(grouped.values())
    .slice(0, 20)
    .map((jobs) =>
      jobs.sort((left, right) => left.turnNumber - right.turnNumber),
    );
}

export async function updateJob(
  env: AppEnv,
  jobId: string,
  update: Partial<
    Pick<
      Job,
      | "assistantMessage"
      | "changedPaths"
      | "clarification"
      | "errorMessage"
      | "prUrl"
      | "status"
      | "summary"
    >
  >,
) {
  const current = await getJob(env, jobId);

  if (!current) throw new HttpError(404, "CMS AIジョブが見つかりません。");

  const next = {
    assistantMessage:
      "assistantMessage" in update
        ? limitOptionalText(update.assistantMessage, 4_000)
        : current.assistantMessage,
    changedPaths:
      "changedPaths" in update
        ? normalizeChangedPaths(update.changedPaths || [])
        : current.changedPaths,
    clarification:
      "clarification" in update
        ? limitOptionalText(update.clarification, 4_000)
        : current.clarification,
    errorMessage:
      "errorMessage" in update
        ? limitOptionalText(update.errorMessage, 2_000)
        : current.errorMessage,
    prUrl: "prUrl" in update ? normalizeGitHubUrl(update.prUrl) : current.prUrl,
    status: update.status || current.status,
    summary:
      "summary" in update
        ? limitOptionalText(update.summary, 4_000)
        : current.summary,
  };
  const updatedAt = new Date().toISOString();

  await env.CMS_AI_DB.prepare(
    [
      "UPDATE cms_ai_jobs SET status = ?, assistant_message = ?, summary = ?,",
      "clarification = ?, pr_url = ?, changed_paths_json = ?, error_message = ?,",
      "updated_at = ? WHERE id = ?",
    ].join(" "),
  )
    .bind(
      next.status,
      next.assistantMessage,
      next.summary,
      next.clarification,
      next.prUrl,
      JSON.stringify(next.changedPaths),
      next.errorMessage,
      updatedAt,
      jobId,
    )
    .run();

  return { ...current, ...next, updatedAt } satisfies Job;
}

function parseMembership(row: MembershipRow): Membership {
  const role = ROLES.includes(row.role as Role) ? (row.role as Role) : "chat";

  return {
    createdAt: row.created_at,
    createdBy: row.created_by,
    enabled: row.enabled === 1,
    principalEmail: row.principal_email,
    role,
    siteId: row.site_id,
    updatedAt: row.updated_at,
  };
}

function parseJob(row: JobRow): Job {
  return {
    attachments: JSON.parse(row.attachments_json || "[]") as ImageAttachment[],
    assistantMessage: limitOptionalText(row.assistant_message, 4_000),
    branchName: row.branch_name,
    changedPaths: parseChangedPaths(row.changed_paths_json),
    clarification: limitOptionalText(row.clarification, 4_000),
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    errorMessage: limitOptionalText(row.error_message, 2_000),
    id: row.id,
    instruction: row.instruction,
    prUrl: normalizeGitHubUrl(row.pr_url),
    reasoningEffort: REASONING_EFFORTS.includes(
      row.reasoning_effort as ReasoningEffort,
    )
      ? (row.reasoning_effort as ReasoningEffort)
      : "medium",
    requestedBy: row.requested_by,
    requestedRole: ROLES.includes(row.requested_role as Role)
      ? (row.requested_role as Role)
      : "chat",
    siteId: row.site_id,
    status: JOB_STATUSES.includes(row.status as JobStatus)
      ? (row.status as JobStatus)
      : "failed",
    summary: limitOptionalText(row.summary, 4_000),
    turnNumber: row.turn_number,
    updatedAt: row.updated_at,
  };
}

function parseChangedPaths(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? normalizeChangedPaths(parsed) : [];
  } catch {
    return [];
  }
}

function normalizeChangedPaths(values: unknown[]) {
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.replace(/\\/g, "/").replace(/^\/+/, ""))
        .filter(
          (value) =>
            value.length > 0 &&
            value.length <= 240 &&
            !value
              .split("/")
              .some((part) => !part || part === "." || part === ".."),
        ),
    ),
  ).slice(0, 100);
}

function limitOptionalText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

function normalizeGitHubUrl(value: unknown) {
  if (typeof value !== "string" || !value) return null;

  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function assertId(value: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new HttpError(400, "CMS AIのIDを確認してください。");
  }
}
