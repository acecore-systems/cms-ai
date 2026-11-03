import { anthropicPayload, anthropicText, HAIKU_MODEL } from "./anthropic.ts";
import { assertStrictSchema } from "./seo-deepseek.ts";

export function haikuSchema(
  request: Record<string, unknown>,
  responses = false,
) {
  const format = responses
    ? (request.text as any)?.format
    : (request.response_format as any);
  const schema = responses
    ? format?.schema
    : (format?.json_schema?.schema ?? format?.json_schema);
  if (
    !schema ||
    format?.type !== "json_schema" ||
    request.tools ||
    request.tool_choice ||
    request.stream === true
  )
    throw Error("seo_haiku_schema");
  return schema;
}

export function haikuPayload(
  request: Record<string, unknown>,
  responses = false,
) {
  const schema = haikuSchema(request, responses);
  const chat = responses
    ? {
        messages: [
          { role: "system", content: request.instructions },
          { role: "user", content: request.input },
        ],
        max_completion_tokens: request.max_output_tokens,
        reasoning_effort: request.reasoning_effort ?? "high",
        response_format: { type: "json_schema", json_schema: schema },
      }
    : {
        ...request,
        response_format: { type: "json_schema", json_schema: schema },
      };
  return anthropicPayload(chat);
}

export function haikuUpperCost(
  payload: Record<string, unknown>,
  now = Date.now(),
) {
  const messages = payload.messages as any[],
    output = payload.max_tokens;
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (
    now < Date.parse("2026-11-03T00:00:00Z") ||
    !Number.isFinite(now) ||
    payload.model !== HAIKU_MODEL ||
    typeof payload.system !== "string" ||
    !Array.isArray(messages) ||
    messages.length !== 1 ||
    messages[0]?.role !== "user" ||
    typeof messages[0]?.content !== "string" ||
    ![6000, 12000, 24000, 48000].includes(output as number) ||
    !["low", "high"].includes((payload.output_config as any)?.effort) ||
    bytes > 900000 ||
    Object.keys(payload).sort().join() !==
      "max_tokens,messages,model,output_config,system"
  )
    throw Error("seo_haiku_bound");
  return haikuCostBound(bytes, output as number);
}

// Always reserve at the long-context rate; the provider does not document
// this byte-derived bound as proof of its 100k-token pricing threshold.
export function haikuCostBound(bytes: number, output: number) {
  const input = bytes + 8192;
  return Math.ceil(input * 0.5 + output * 2.5);
}

export function validateHaikuResponse(
  raw: any,
  payload: Record<string, unknown>,
  schema: unknown,
  deadline: number,
) {
  const reserved = haikuUpperCost(payload),
    usage = raw?.usage;
  const input = usage?.input_tokens,
    output = usage?.output_tokens;
  const read = usage?.cache_read_input_tokens ?? 0,
    write = usage?.cache_creation_input_tokens ?? 0;
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (
    Date.now() >= deadline ||
    ![input, output, read, write].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    read !== 0 ||
    write !== 0 ||
    output > (payload.max_tokens as number) ||
    input > bytes + 8192 ||
    input * 0.5 + output * 2.5 > reserved
  )
    throw Error("seo_haiku_usage");
  const text = anthropicText(raw);
  assertStrictSchema(JSON.parse(text), schema);
  return text;
}

export function normalizedHaiku(raw: any, text: string) {
  return {
    adapterVersion: 1,
    provider: "anthropic",
    model: HAIKU_MODEL,
    id: raw.id,
    status: "completed",
    usage: {
      input_tokens: raw.usage.input_tokens,
      output_tokens: raw.usage.output_tokens,
    },
    output: [
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
  };
}
