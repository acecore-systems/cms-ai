import type { AppEnv } from "./env.ts";

// User-approved ceiling, in millionths of USD. Failed/unknown calls retain their reservation.
export const SEO_BUDGET = {
  runMicros: 1_000_000,
  monthMicros: 5_000_000,
} as const;
// Conservative rates above standard long-context rates verified 2026-10-19.
// Text only; no cache writes, tools, images, priority tier or model fallback.
export const RATE_VALID_UNTIL = Date.parse("2026-11-19T00:00:00Z");
export function upperCost(
  model: string,
  request: Record<string, unknown>,
  now = Date.now(),
) {
  if (
    model !== "gpt-6-luna" ||
    now >= RATE_VALID_UNTIL ||
    now < Date.parse("2026-10-19T00:00:00Z")
  )
    throw new Error("seo_rate_review_required");
  const output = request.max_completion_tokens;
  if (
    !Number.isSafeInteger(output) ||
    (output as number) < 1 ||
    (output as number) > 12_000 ||
    request.tools ||
    request.service_tier !== "default"
  )
    throw new Error("seo_request_not_bounded");
  // UTF-8 bytes bound byte-level text tokens. Include a generous envelope/schema allowance.
  const bytes = new TextEncoder().encode(JSON.stringify(request)).length;
  if (bytes > 900_000) throw new Error("seo_request_too_large");
  return bytes + 8192 + (output as number) * 2;
}
export function jstMonth(now: number) {
  return new Date(now + 9 * 3600_000).toISOString().slice(0, 7);
}
export async function sha256(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export class SeoBudget {
  constructor(private db: AppEnv["CMS_AI_DB"]) {}
  async reserve(
    runId: string,
    callId: string,
    article: string,
    hash: string,
    amount: number,
    now = Date.now(),
  ) {
    if (
      !/^seo-[0-9a-f-]{36}$/.test(runId) ||
      !/^seo-[0-9a-f-]{36}$/.test(callId) ||
      !/^[0-9a-f]{64}$/.test(hash) ||
      !Number.isSafeInteger(amount) ||
      amount < 1 ||
      amount > SEO_BUDGET.runMicros
    )
      throw new Error("seo_invalid_budget_request");
    // One transaction: a conflicting article, expired run, duplicate call or cap cannot charge/run again.
    const results = await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO seo_budget_runs(id,article_key,created_at,deadline) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING",
        )
        .bind(runId, article, now, now + 30 * 60_000),
      this.db
        .prepare(
          "INSERT INTO seo_budget_calls(id,run_id,month_jst,request_sha256,reserved_micros,created_at) SELECT ?,id,?,?,?,? FROM seo_budget_runs WHERE id=? AND article_key=? AND deadline>? AND created_at<=? ON CONFLICT(id) DO NOTHING",
        )
        .bind(
          callId,
          jstMonth(now),
          hash,
          amount,
          now,
          runId,
          article,
          now,
          now,
        ),
    ]);
    if (results[1].meta.changes !== 1)
      throw new Error("seo_duplicate_or_conflict");
  }
  async finish(callId: string, status: "complete" | "unresolved") {
    const result = await this.db
      .prepare(
        "UPDATE seo_budget_calls SET status=? WHERE id=? AND status='reserved'",
      )
      .bind(status, callId)
      .run();
    if (result.meta.changes !== 1) throw new Error("seo_budget_state_conflict");
  }
}
