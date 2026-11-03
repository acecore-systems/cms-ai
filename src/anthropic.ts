import type { AppEnv } from "./env.ts";

export const HAIKU_MODEL = "claude-haiku-5-5";

// Anthropic rejects unsupported JSON Schema constraints. The caller's normal
// response validator still enforces the original limits after decoding.
export function providerSchema(value: any): any {
  if (Array.isArray(value)) return value.map(providerSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["minLength", "maxLength", "maxItems"].includes(key))
      .map(([key, item]) => [key, providerSchema(item)]),
  );
}

export function anthropicPayload(request: Record<string, unknown>) {
  const messages = request.messages as any[];
  const schema = (request.response_format as any)?.json_schema;
  if (
    !Array.isArray(messages) ||
    messages[0]?.role !== "system" ||
    typeof messages[0].content !== "string" ||
    !schema ||
    request.tools ||
    request.stream
  )
    throw Error("anthropic_request_invalid");
  const mapped = messages.slice(1).map((message) => {
    if (!["user", "assistant"].includes(message.role))
      throw Error("anthropic_role");
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part: any) => {
            if (part.type === "text" && typeof part.text === "string")
              return part;
            const match =
              /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
                part.image_url?.url ?? "",
              );
            if (part.type !== "image_url" || !match)
              throw Error("anthropic_image");
            return {
              type: "image",
              source: { type: "base64", media_type: match[1], data: match[2] },
            };
          });
    return { role: message.role, content };
  });
  return {
    model: HAIKU_MODEL,
    system: messages[0].content,
    messages: mapped,
    max_tokens: request.max_completion_tokens,
    output_config: {
      effort: request.reasoning_effort,
      format: { type: "json_schema", schema: providerSchema(schema) },
    },
  };
}

export async function runAnthropic(
  env: AppEnv,
  request: Record<string, unknown>,
  deadline?: number,
) {
  const raw = await callAnthropic(env, anthropicPayload(request), deadline);
  return {
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: anthropicText(raw) },
      },
    ],
  };
}

export async function callAnthropic(
  env: AppEnv,
  payload: Record<string, unknown>,
  deadline?: number,
  beforeRequest?: () => Promise<void>,
  onResponse?: (raw: unknown) => Promise<void>,
  timeoutMs = 120_000,
) {
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw Error("anthropic_credentials_missing");
  if (deadline !== undefined && Date.now() >= deadline)
    throw Error("anthropic_deadline");
  if (beforeRequest) await beforeRequest();
  if (deadline !== undefined && Date.now() >= deadline)
    throw Error("anthropic_deadline");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    redirect: "manual",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(
      Math.max(
        1,
        Math.min(
          timeoutMs,
          deadline === undefined ? timeoutMs : deadline - Date.now(),
        ),
      ),
    ),
  });
  if (!response.ok) throw Error("anthropic_provider_error");
  const body = await response.text();
  if (body.length > 2_000_000) throw Error("anthropic_response_too_large");
  const raw = JSON.parse(body);
  if (onResponse) await onResponse(raw);
  return raw;
}

export function anthropicText(raw: any): string {
  const texts = Array.isArray(raw.content)
    ? raw.content.filter((part: any) => part.type === "text")
    : [];
  if (
    raw.type !== "message" ||
    raw.role !== "assistant" ||
    raw.model !== HAIKU_MODEL ||
    raw.stop_reason !== "end_turn" ||
    texts.length !== 1 ||
    typeof texts[0].text !== "string" ||
    !texts[0].text.trim() ||
    raw.content.some(
      (part: any) =>
        !["text", "thinking", "redacted_thinking"].includes(part.type),
    )
  )
    throw Error("anthropic_response_invalid");
  return texts[0].text;
}
