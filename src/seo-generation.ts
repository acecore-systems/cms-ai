import type { AppEnv } from "./env.ts";
import { runInference, validateSourceFiles } from "./inference.ts";
import type { Job } from "./models.ts";
import { ProviderFailure } from "./provider-failure.ts";
import { SITES, isSiteWritablePath } from "./sites.ts";
import {
  SeoBudget,
  sha256,
  upperCost,
  SEO_BUDGET,
  RATE_VALID_UNTIL,
} from "./seo-budget.ts";

const uuid =
  /^seo-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function generationReadiness(env: AppEnv) {
  return {
    protocol: "acecore-seo-generation-v1",
    enabled: String(env.SEO_GENERATION_ENABLED) === "true",
    dispatchEnabled: false,
    budget: { ...SEO_BUDGET, currency: "USD", monthTimezone: "Asia/Tokyo" },
    rateValidUntil: RATE_VALID_UNTIL,
  };
}
export async function generateSeo(env: AppEnv, input: unknown) {
  if (String(env.SEO_GENERATION_ENABLED) !== "true")
    return { status: "disabled" as const };
  let reserved = false;
  let stage = "validation";
  let callId = "";
  const budget = new SeoBudget(env.CMS_AI_DB);
  try {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("invalid");
    const value = input as Record<string, unknown>;
    const keys = [
      "runId",
      "callId",
      "siteId",
      "articlePath",
      "allowedPaths",
      "instruction",
      "files",
    ];
    if (
      Object.keys(value).some((k) => !keys.includes(k) && k !== "deadline") ||
      !keys.every((k) => k in value)
    )
      throw new Error("invalid");
    const deadline = value.deadline;
    if (
      deadline !== undefined &&
      (!Number.isSafeInteger(deadline) ||
        (deadline as number) <= Date.now() ||
        (deadline as number) > Date.now() + 30 * 60_000)
    )
      throw new Error("deadline");
    const { runId, siteId, articlePath, instruction } = value;
    callId = typeof value.callId === "string" ? value.callId : "";
    const site = SITES.find((s) => s.id === siteId);
    if (
      !site ||
      typeof runId !== "string" ||
      !uuid.test(runId) ||
      !uuid.test(callId) ||
      typeof articlePath !== "string" ||
      !articlePath.endsWith(".md") ||
      !isSiteWritablePath(site, articlePath) ||
      typeof instruction !== "string" ||
      instruction.length < 1 ||
      instruction.length > 12_000
    )
      throw new Error("invalid");
    const files = validateSourceFiles(site, value.files);
    const paths = value.allowedPaths;
    if (
      !Array.isArray(paths) ||
      paths.length < 1 ||
      paths.length > 20 ||
      new Set(paths).size !== paths.length ||
      !files.some((f) => f.path === articlePath) ||
      !paths.every(
        (p) =>
          typeof p === "string" &&
          isSiteWritablePath(site, p) &&
          files.some((f) => f.path === p),
      )
    )
      throw new Error("invalid");
    const job: Job = {
      attachments: [],
      assistantMessage: null,
      branchName: "",
      changedPaths: [],
      clarification: null,
      conversationId: runId,
      createdAt: new Date().toISOString(),
      errorMessage: null,
      id: callId,
      instruction:
        "SEOの改訂案のみを作成する。提供資料を根拠とし、未確認の事実を追加しない。URL・公開日・著者・画像・既存事実を維持する。変更は次の許可pathだけ: " +
        JSON.stringify(paths) +
        "\n" +
        instruction,
      prUrl: null,
      // The production Chat Completions endpoint rejected max (400 unsupported_value).
      // Pin high for SEO; do not retry or silently switch effort after an API call.
      reasoningEffort: "high",
      requestedBy: "seo-service",
      requestedRole: "editor",
      siteId: site.id,
      status: "running",
      summary: null,
      turnNumber: 1,
      updatedAt: new Date().toISOString(),
    };
    const result = await runInference(
      env,
      site,
      job,
      files,
      [],
      undefined,
      async (model, request) => {
        stage = "budget";
        await budget.reserve(
          runId,
          callId,
          site.id + ":" + articlePath,
          await sha256(JSON.stringify(request)),
          upperCost(model, request),
          Date.now(),
          deadline as number | undefined,
        );
        reserved = true;
        stage = "generation";
      },
      deadline as number | undefined,
    );
    stage = "result_validation";
    if (!result.changes.every((c) => paths.includes(c.path)))
      throw new Error("unexpected_path");
    // Saving before returning preserves a result when the RPC response is lost. No public read route.
    stage = "result_storage";
    const saved = await env.CMS_AI_IMAGES.put(
      "seo-proposals/" + callId + ".json",
      JSON.stringify(result),
      {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
      },
    );
    if (!saved) throw new Error("result_conflict");
    stage = "completion";
    await budget.finish(callId, "complete");
    return {
      status: "proposal_created" as const,
      result,
      dispatchExecuted: false,
    };
  } catch (error) {
    const diagnostic = {
      stage,
      ...(error instanceof ProviderFailure
        ? {
            providerStatus: error.providerStatus,
            providerCode: error.providerCode,
            providerParam: error.providerParam,
          }
        : {}),
    };
    if (reserved) {
      try {
        await budget.finish(callId, "unresolved");
      } catch {
        /* Keep the reservation. */
      }
      try {
        await env.CMS_AI_IMAGES.put(
          "seo-outcomes/" + callId + ".json",
          JSON.stringify(diagnostic),
          { onlyIf: { etagDoesNotMatch: "*" } },
        );
      } catch {
        /* Reservation remains authoritative. */
      }
    }
    // Never return source, credentials, SQL/provider error text, or a raw upstream response.
    return {
      status: reserved ? ("unresolved" as const) : ("stopped" as const),
      ...diagnostic,
    };
  }
}
