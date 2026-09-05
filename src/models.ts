import { HttpError } from "./http.ts";

export const ROLES = ["chat", "editor", "admin"] as const;
export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export const JOB_STATUSES = [
  "queued",
  "running",
  "validating",
  "responded",
  "failed",
  "pr_created",
  "merged",
] as const;

export type Role = (typeof ROLES)[number];
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];

export type Membership = {
  createdAt: string;
  createdBy: string;
  enabled: boolean;
  principalEmail: string;
  role: Role;
  siteId: string;
  updatedAt: string;
};

export type Job = {
  attachments: ImageAttachment[];
  assistantMessage: string | null;
  branchName: string;
  changedPaths: string[];
  clarification: string | null;
  conversationId: string;
  createdAt: string;
  errorMessage: string | null;
  id: string;
  instruction: string;
  prUrl: string | null;
  reasoningEffort: ReasoningEffort;
  requestedBy: string;
  requestedRole: Role;
  siteId: string;
  status: JobStatus;
  summary: string | null;
  turnNumber: number;
  updatedAt: string;
};

export type ImageAttachment = {
  id: string;
  name: string;
  type: "image/png" | "image/jpeg" | "image/webp";
  size: number;
};

export function parseRole(value: unknown): Role {
  if (
    typeof value === "string" &&
    (ROLES as readonly string[]).includes(value)
  ) {
    return value as Role;
  }

  throw new HttpError(400, "権限を確認してください。");
}

export function parseReasoningEffort(value: unknown): ReasoningEffort {
  const normalized = String(value || "").trim();

  if (!normalized) return "medium";

  if ((REASONING_EFFORTS as readonly string[]).includes(normalized)) {
    return normalized as ReasoningEffort;
  }

  throw new HttpError(400, "AIの考える深さを選択してください。");
}

export function canEdit(role: Role) {
  return role === "editor" || role === "admin";
}
