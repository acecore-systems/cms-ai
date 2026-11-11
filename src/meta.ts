import type { AppEnv } from "./env.ts";

export const MUSE_MODEL = "muse-ember-1.0";

// Only the CMS path uses this adapter; SEO requires a separately pinned
// model contract, budget reservation, and immutable audit records.
export function metaPayload(request: Record<string, unknown>) {
  const schema = (request.response_format as any)?.json_schema;
  if (
    !Array.isArray(request.messages) ||
    !schema ||
    request.tools ||
    request.stream
  )
    throw Error("meta_request_invalid");
  return {
    model: MUSE_MODEL,
    messages: request.messages,
    max_tokens: request.max_completion_tokens,
    reasoning_effort: "medium",
    store: false,
    response_format: {
      type: "json_schema",
      json_schema: { name: "cms_ai_changes", schema, strict: true },
    },
  };
}

export async function runMeta(
  env: AppEnv,
  request: Record<string, unknown>,
  deadline?: number,
) {
  let key: string;
  try {
    key = (await env.META_API_KEY_STORE?.get())?.trim() || "";
  } catch {
    throw Error("meta_credentials_missing");
  }
  if (!key) throw Error("meta_credentials_missing");
  if (deadline !== undefined && Date.now() >= deadline)
    throw Error("meta_deadline");
  const response = await fetch("https://api.meta.ai/v1/chat/completions", {
    method: "POST",
    redirect: "manual",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(metaPayload(request)),
    signal: AbortSignal.timeout(
      Math.max(
        1,
        Math.min(
          120_000,
          deadline === undefined ? 120_000 : deadline - Date.now(),
        ),
      ),
    ),
  });
  if (!response.ok) throw Error("meta_provider_error");
  const body = await response.text();
  if (body.length > 2_000_000) throw Error("meta_response_too_large");
  const raw = JSON.parse(body);
  if (
    raw?.model !== MUSE_MODEL ||
    raw?.choices?.length !== 1 ||
    raw.choices[0]?.finish_reason !== "stop" ||
    typeof raw.choices[0]?.message?.content !== "string"
  )
    throw Error("meta_response_invalid");
  return raw;
}
