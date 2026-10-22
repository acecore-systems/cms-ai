import { assertStageInput } from "./seo-stage-budget.ts";
import type { AppEnv } from "./env.ts";
import { SeoBudget, sha256, RATE_VALID_UNTIL } from "./seo-budget.ts";

export const RESEARCH_TOOLS = 3;
// Official 2026-10-20: web-search context <=128k; max_tool_calls bounds all
// hosted calls. Reserve every possible model pass (N+1) at >=long-context,
// cache-write + regional rates, plus $0.01 for EVERY call (including opens).
// No usage-based refund: failures/unknown results retain the full reservation.
export function responsesUpperCost(
  request: Record<string, unknown>,
  now = Date.now(),
) {
  if (
    now < Date.parse("2026-10-20T00:00:00Z") ||
    now >= RATE_VALID_UNTIL ||
    request.model !== "gpt-6-luna" ||
    request.service_tier !== "default" ||
    request.store !== false ||
    request.background !== false ||
    request.previous_response_id ||
    request.conversation ||
    request.prompt_cache_options ||
    request.truncation !== "disabled" ||
    request.max_output_tokens !== 6000
  )
    throw new Error("seo_research_rate");
  const bytes = new TextEncoder().encode(JSON.stringify(request)).length;
  if (bytes > 768_000) throw new Error("seo_research_size");
  if (request.tools !== undefined) {
    if (
      JSON.stringify(request.tools) !==
        JSON.stringify([
          {
            type: "web_search",
            search_context_size: "low",
            external_web_access: true,
          },
        ]) ||
      ![1, RESEARCH_TOOLS].includes(request.max_tool_calls as number) ||
      request.tool_choice !== "required" ||
      bytes + 8192 > 128_000
    )
      throw new Error("seo_research_bound");
    return Math.ceil(
      (128_000 + bytes + 8192) *
        ((request.max_tool_calls as number) + 1) *
        0.3 +
        (request.max_tool_calls as number) * 10_000 +
        6000,
    );
  }
  if (request.max_tool_calls !== undefined || request.tool_choice !== undefined)
    throw new Error("seo_research_bound");
  return Math.ceil((bytes + 8192) * 0.3 + 6000);
}

export async function seoResponse(
  env: AppEnv,
  args: {
    runId: string;
    budgetVersion?: number;
    callId: string;
    articleKey: string;
    deadline: number;
    request: Record<string, unknown>;
    phase?: "plan" | "discovery" | "research" | "review";
  },
) {
  if (
    String(env.SEO_GENERATION_ENABLED) !== "true" ||
    env.SEO_AI_MODEL !== "gpt-6-luna"
  )
    throw new Error("seo_research_disabled");
  const budget = new SeoBudget(env.CMS_AI_DB);
  let reserved = false;
  try {
    assertStageInput(
      (args.phase === "discovery" ? "research" : args.phase) ||
        (args.request.tools ? "research" : "review"),
      args.request,
      args.budgetVersion,
    );
    const amount = responsesUpperCost(args.request);
    // Runtime binding only; no key is read by the development agent or runner.
    const key = (await env.OPENAI_API_KEY_STORE?.get())?.trim();
    if (!key) throw new Error("seo_research_credentials");
    await budget.reserve(
      args.runId,
      args.callId,
      args.articleKey,
      await sha256(JSON.stringify(args.request)),
      amount,
      Date.now(),
      args.deadline,
      args.budgetVersion,
    );
    reserved = true;
    if (Date.now() >= args.deadline)
      throw new Error("seo_deadline_or_terminal");
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args.request),
      signal: AbortSignal.timeout(
        Math.min(120_000, args.deadline - Date.now()),
      ),
    });
    if (!response.ok) throw new Error("seo_research_provider");
    const raw = await response.text();
    if (raw.length > 2_000_000) throw new Error("seo_research_size");
    const result = JSON.parse(raw);
    // Preserve provider evidence before accepting it. This is private, not a log.
    if (
      !(await env.CMS_AI_IMAGES.put(
        "seo-responses/" + args.callId + ".json",
        raw,
        {
          onlyIf: { etagDoesNotMatch: "*" },
          httpMetadata: { contentType: "application/json" },
        },
      ))
    )
      throw new Error("seo_research_storage");
    if (
      Date.now() >= args.deadline ||
      result.status !== "completed" ||
      !Number.isSafeInteger(result.usage?.input_tokens) ||
      result.usage.input_tokens < 0 ||
      !Number.isSafeInteger(result.usage?.output_tokens) ||
      result.usage.output_tokens < 0 ||
      result.usage.output_tokens > 6000 ||
      result.usage.input_tokens * 0.3 +
        result.usage.output_tokens +
        (args.request.tools
          ? (args.request.max_tool_calls as number) * 10_000
          : 0) >
        amount
    )
      throw new Error("seo_research_response");
    await budget.finish(args.callId, "complete");
    return result;
  } catch (error) {
    if (reserved) {
      try {
        await budget.finish(args.callId, "unresolved");
      } catch {
        /* Never release. */
      }
    }
    if (error instanceof Error && error.message === "seo_stage_input_budget")
      throw error;
    throw new Error("seo_research_call");
  }
}

export function responseRequest(
  instructions: string,
  input: unknown,
  schema: unknown,
  search = false,
) {
  return {
    model: "gpt-6-luna",
    service_tier: "default",
    store: false,
    background: false,
    truncation: "disabled",
    max_output_tokens: 6000,
    reasoning: { effort: "high" },
    instructions,
    input: JSON.stringify(input),
    text: search
      ? { format: { type: "text" } }
      : {
          format: {
            type: "json_schema",
            name: search ? "seo_research" : "seo_review",
            strict: true,
            schema,
          },
        },
    ...(search
      ? {
          tools: [
            {
              type: "web_search",
              search_context_size: "low",
              external_web_access: true,
            },
          ],
          max_tool_calls: RESEARCH_TOOLS,
          tool_choice: "required",
          include: ["web_search_call.action.sources"],
        }
      : {}),
  };
}

export function responseText(result: any) {
  const { text, annotations } = responseMessage(result);
  return { value: JSON.parse(text), annotations };
}

export function responseMessage(result: any) {
  if (!Array.isArray(result.output)) throw new Error("seo_research_response");
  const messages = result.output.filter((item: any) => item.type === "message");
  if (
    messages.length !== 1 ||
    messages[0].status !== "completed" ||
    messages[0].role !== "assistant"
  )
    throw new Error("seo_research_response");
  const content = messages[0].content;
  if (
    !Array.isArray(content) ||
    content.length !== 1 ||
    content[0].type !== "output_text" ||
    typeof content[0].text !== "string"
  )
    throw new Error("seo_research_response");
  return {
    text: content[0].text as string,
    annotations: content[0].annotations || [],
  };
}
