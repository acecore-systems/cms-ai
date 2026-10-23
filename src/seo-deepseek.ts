// Text-only SEO contract. Normal CMS inference does not use these stricter gates.
export const SEO_DEEPSEEK = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
const bytes = (v: unknown) =>
  new TextEncoder().encode(JSON.stringify(v)).length;
export function deepseekPayload(
  request: Record<string, unknown>,
  responses = false,
) {
  if (request.tools || request.tool_choice || request.stream === true)
    throw Error("seo_deepseek_tools");
  const format = responses
    ? (request.text as any)?.format
    : (request.response_format as any);
  const schema = responses
    ? format?.schema
    : (format?.json_schema?.schema ?? format?.json_schema);
  if (!schema || (responses && format?.type !== "json_schema"))
    throw Error("seo_deepseek_schema");
  return {
    store: false,
    messages: responses
      ? [
          { role: "system", content: request.instructions },
          { role: "user", content: request.input },
        ]
      : request.messages,
    reasoning_effort: "high",
    max_completion_tokens: responses
      ? request.max_output_tokens
      : request.max_completion_tokens,
    response_format: {
      type: "json_schema",
      json_schema: { name: "seo_text", strict: true, schema },
    },
    stream: false,
  };
}
export function deepseekUpperCost(
  request: Record<string, unknown>,
  now = Date.now(),
) {
  const output = request.max_completion_tokens;
  if (
    now < Date.parse("2026-10-23T00:00:00Z") ||
    now >= Date.parse("2026-11-19T00:00:00Z") ||
    Object.keys(request).sort().join() !==
      "max_completion_tokens,messages,reasoning_effort,response_format,store,stream" ||
    request.store !== false ||
    request.reasoning_effort !== "high" ||
    request.stream !== false ||
    ![6000, 12000, 24000].includes(output as number) ||
    !Array.isArray(request.messages) ||
    request.messages.length !== 2 ||
    request.messages.some(
      (m: any, i: number) =>
        m.role !== (i ? "user" : "system") || typeof m.content !== "string",
    ) ||
    (request.response_format as any)?.json_schema?.strict !== true ||
    bytes(request) > 900000
  )
    throw Error("seo_deepseek_bound");
  // UTF-8 byte upper bound + envelope allowance; no cache discount. Output includes reasoning.
  return Math.ceil(
    ((bytes(request) + 8192) * 3 + (output as number) * 12) / 10,
  );
}
export function assertStrictSchema(value: any, schema: any): void {
  if (!schema || typeof schema !== "object") throw Error("seo_deepseek_schema");
  if (schema.enum && !schema.enum.includes(value))
    throw Error("seo_deepseek_schema");
  if (schema.type === "object") {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      schema.additionalProperties !== false ||
      Object.keys(value).some((k) => !(k in schema.properties)) ||
      schema.required.some((k: string) => !(k in value))
    )
      throw Error("seo_deepseek_schema");
    for (const [k, v] of Object.entries(value))
      assertStrictSchema(v, schema.properties[k]);
  } else if (schema.type === "array") {
    if (
      !Array.isArray(value) ||
      (schema.minItems !== undefined && value.length < schema.minItems) ||
      (schema.maxItems !== undefined && value.length > schema.maxItems)
    )
      throw Error("seo_deepseek_schema");
    for (const v of value) assertStrictSchema(v, schema.items);
  } else if (schema.type === "string") {
    if (
      typeof value !== "string" ||
      (schema.minLength !== undefined && value.length < schema.minLength) ||
      (schema.maxLength !== undefined && value.length > schema.maxLength)
    )
      throw Error("seo_deepseek_schema");
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") throw Error("seo_deepseek_schema");
  } else throw Error("seo_deepseek_schema");
}
export function validateDeepseekResponse(
  raw: any,
  payload: Record<string, unknown>,
  deadline: number,
) {
  const amount = deepseekUpperCost(payload);
  const u = raw?.usage,
    c = raw?.choices?.[0];
  if (
    Date.now() >= deadline ||
    bytes(raw) > 2000000 ||
    (raw.model !== undefined && raw.model !== SEO_DEEPSEEK) ||
    !Array.isArray(raw.choices) ||
    raw.choices.length !== 1 ||
    c?.finish_reason !== "stop" ||
    c.message?.role !== "assistant" ||
    c.message.refusal ||
    c.message.tool_calls ||
    c.message.function_call ||
    typeof c.message.content !== "string" ||
    !Number.isSafeInteger(u?.prompt_tokens) ||
    u.prompt_tokens < 0 ||
    !Number.isSafeInteger(u?.completion_tokens) ||
    u.completion_tokens < 0 ||
    u.completion_tokens > (payload.max_completion_tokens as number) ||
    (u.prompt_tokens * 3 + u.completion_tokens * 12) / 10 > amount ||
    (u.completion_tokens_details?.reasoning_tokens !== undefined &&
      (!Number.isSafeInteger(u.completion_tokens_details.reasoning_tokens) ||
        u.completion_tokens_details.reasoning_tokens < 0 ||
        u.completion_tokens_details.reasoning_tokens > u.completion_tokens))
  )
    throw Error("seo_deepseek_response");
  assertStrictSchema(
    JSON.parse(c.message.content),
    (payload.response_format as any).json_schema.schema,
  );
  return raw;
}
export function normalizedDeepseek(raw: any) {
  return {
    adapterVersion: 1,
    provider: "workers-ai",
    model: SEO_DEEPSEEK,
    id: raw.id ?? "workers-ai",
    status: "completed",
    usage: {
      input_tokens: raw.usage.prompt_tokens,
      output_tokens: raw.usage.completion_tokens,
    },
    output: [
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: raw.choices[0].message.content,
            annotations: [],
          },
        ],
      },
    ],
  };
}
