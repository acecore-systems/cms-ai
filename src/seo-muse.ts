import { metaPayload, MUSE_MODEL } from "./meta.ts";
import type { SeoMuseEffort } from "./seo-muse-effort.ts";
import { assertStrictSchema } from "./seo-deepseek.ts";
import { textSchema } from "./seo-text-schema.ts";

// SEO is text-only, and its exact outbound envelope is also used for preflight
// and reservation.
export function musePayload(
  request: Record<string, unknown>,
  responses = false,
  effort: SeoMuseEffort = "medium",
) {
  const schema = textSchema(request, responses);
  return metaPayload(
    responses
      ? {
          messages: [
            { role: "system", content: request.instructions },
            { role: "user", content: request.input },
          ],
          max_completion_tokens: request.max_output_tokens,
          reasoning_effort: effort,
          response_format: { type: "json_schema", json_schema: schema },
        }
      : {
          ...request,
          reasoning_effort: effort,
          response_format: { type: "json_schema", json_schema: schema },
        },
  );
}

// Reserve all input at the greater-than-200k rate, including cached tokens;
// output includes reasoning. No refunds on failed or uncertain calls.
export function museCostBound(bytes: number, output: number) {
  return Math.ceil((bytes + 8192) * 0.3 + output * 1.5);
}

export function museUpperCost(payload: Record<string, unknown>) {
  const messages = payload.messages as any[],
    output = payload.max_tokens;
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (
    payload.model !== MUSE_MODEL ||
    !["low", "medium", "max"].includes(payload.reasoning_effort as string) ||
    payload.store !== false ||
    !Array.isArray(messages) ||
    messages.length !== 2 ||
    messages[0]?.role !== "system" ||
    messages[1]?.role !== "user" ||
    typeof messages[0].content !== "string" ||
    typeof messages[1].content !== "string" ||
    ![6000, 12000, 24000, 48000].includes(output as number) ||
    bytes > 900000 ||
    Object.keys(payload).sort().join() !==
      "max_tokens,messages,model,reasoning_effort,response_format,store"
  )
    throw Error("seo_muse_bound");
  return museCostBound(bytes, output as number);
}

export function validateMuseResponse(
  raw: any,
  payload: Record<string, unknown>,
  schema: unknown,
  deadline: number,
) {
  const reserved = museUpperCost(payload),
    input = raw?.usage?.prompt_tokens,
    output = raw?.usage?.completion_tokens;
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (
    Date.now() >= deadline ||
    ![input, output].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    input > bytes + 8192 ||
    output > (payload.max_tokens as number) ||
    input * 0.3 + output * 1.5 > reserved ||
    raw?.model !== MUSE_MODEL ||
    raw?.choices?.length !== 1 ||
    raw.choices[0]?.finish_reason !== "stop" ||
    typeof raw.choices[0]?.message?.content !== "string"
  )
    throw Error("seo_muse_usage");
  const text = raw.choices[0].message.content;
  assertStrictSchema(JSON.parse(text), schema);
  return text;
}
