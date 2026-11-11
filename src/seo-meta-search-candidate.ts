// Offline compatibility candidate only. It is deliberately not wired to any
// provider call or job: search cost bounds and the v5 evidence contract remain
// unresolved. In particular a web_search_call may contain multiple queries.
import { MUSE_MODEL } from "./meta.ts";

export function metaSearchCandidateRequest(request: Record<string, unknown>) {
  const tools = request.tools as any;
  if (
    request.model !== "gpt-6-luna" ||
    request.service_tier !== "default" ||
    request.store !== false ||
    request.background !== false ||
    request.truncation !== "disabled" ||
    request.previous_response_id !== undefined ||
    request.conversation !== undefined ||
    request.prompt_cache_options !== undefined ||
    request.tool_choice !== "required" ||
    !Number.isSafeInteger(request.max_tool_calls) ||
    (request.max_tool_calls as number) < 1 ||
    (request.max_tool_calls as number) > 3 ||
    !Array.isArray(tools) ||
    tools.length !== 1 ||
    tools[0]?.type !== "web_search" ||
    tools[0]?.external_web_access !== true ||
    Object.keys(tools[0] || {})
      .sort()
      .join() !== "external_web_access,search_context_size,type" ||
    !["low", "high"].includes(tools[0]?.search_context_size) ||
    JSON.stringify(request.include) !==
      JSON.stringify(["web_search_call.action.sources"]) ||
    JSON.stringify(request.reasoning) !== JSON.stringify({ effort: "high" }) ||
    typeof request.instructions !== "string" ||
    typeof request.input !== "string" ||
    request.max_output_tokens !== 6000
  )
    throw Error("seo_meta_candidate_request");
  return {
    model: MUSE_MODEL,
    store: false,
    background: false,
    truncation: "disabled",
    max_output_tokens: request.max_output_tokens,
    reasoning: { effort: "medium" },
    instructions: request.instructions,
    input: request.input,
    text: request.text,
    tools: [
      { type: "web_search", search_context_size: tools[0].search_context_size },
    ],
    max_tool_calls: request.max_tool_calls,
    tool_choice: "auto",
    include: ["web_search_call.results"],
  };
}

type EvidenceScope =
  | { mode: "discovery"; plannedQueries: string[] }
  | { mode: "retrieval"; allowedUrls: string[] };

// Inspect the unmodified response; never claim that a search result was opened
// or synthesize a citation. Callers must separately persist and hash raw output.
export function inspectMetaSearchCandidate(
  raw: any,
  maxCalls: number,
  scope: EvidenceScope,
) {
  if (
    !Number.isSafeInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > 3 ||
    raw?.status !== "completed" ||
    raw?.error ||
    raw?.incomplete_details ||
    raw?.model !== MUSE_MODEL ||
    typeof raw.id !== "string" ||
    !/^resp_[A-Za-z0-9_-]+$/.test(raw.id) ||
    !Array.isArray(raw.output) ||
    !Number.isSafeInteger(raw.usage?.input_tokens) ||
    raw.usage.input_tokens < 0 ||
    !Number.isSafeInteger(raw.usage?.output_tokens) ||
    raw.usage.output_tokens < 0 ||
    raw.usage.output_tokens > 6000 ||
    raw.output.some(
      (item: any) =>
        !["reasoning", "message", "web_search_call"].includes(item?.type),
    )
  )
    throw Error("seo_meta_candidate_response");
  const calls = raw.output.filter(
    (item: any) => item.type === "web_search_call",
  );
  if (
    !calls.length ||
    calls.length > maxCalls ||
    calls.some((item: any) => item.status !== "completed")
  )
    throw Error("seo_meta_candidate_calls");
  if (scope.mode === "discovery") {
    if (
      calls.length !== 1 ||
      calls[0].action?.type !== "search" ||
      !Array.isArray(calls[0].results) ||
      !calls[0].results.length
    )
      throw Error("seo_meta_candidate_search");
    const queries =
      calls[0].action.queries ??
      (calls[0].action.query ? [calls[0].action.query] : []);
    if (
      !Array.isArray(queries) ||
      !queries.length ||
      !scope.plannedQueries.length ||
      queries.length > scope.plannedQueries.length ||
      new Set(queries).size !== queries.length ||
      queries.some(
        (q: any) => typeof q !== "string" || !scope.plannedQueries.includes(q),
      )
    )
      throw Error("seo_meta_candidate_queries");
    if (
      calls[0].results.some(
        (r: any) =>
          r?.type !== "text_result" ||
          typeof r.url !== "string" ||
          !r.url.startsWith("https://"),
      )
    )
      throw Error("seo_meta_candidate_sources");
  } else if (scope.mode === "retrieval") {
    if (
      !scope.allowedUrls.length ||
      calls.some(
        (item: any) =>
          item.action?.type !== "open_page" ||
          !scope.allowedUrls.includes(item.action.url),
      )
    )
      throw Error("seo_meta_candidate_open");
  } else throw Error("seo_meta_candidate_mode");
  const messages = raw.output.filter((item: any) => item.type === "message");
  const last = messages.at(-1);
  if (
    !last ||
    last.status !== "completed" ||
    last.role !== "assistant" ||
    !Array.isArray(last.content) ||
    last.content.length !== 1 ||
    last.content[0]?.type !== "output_text" ||
    typeof last.content[0]?.text !== "string"
  )
    throw Error("seo_meta_candidate_message");
  // Earlier provider citations cannot be moved to another message without
  // invalidating offsets. Preserve the raw output and reject that case.
  if (
    messages
      .slice(0, -1)
      .some(
        (m: any) =>
          m.status !== "completed" ||
          m.role !== "assistant" ||
          !Array.isArray(m.content) ||
          m.content.some(
            (c: any) =>
              c.type !== "output_text" ||
              typeof c.text !== "string" ||
              !Array.isArray(c.annotations ?? []) ||
              (c.annotations ?? []).length,
          ),
      )
  )
    throw Error("seo_meta_candidate_annotations");
  const annotations = last.content[0].annotations;
  if (!Array.isArray(annotations))
    throw Error("seo_meta_candidate_annotations");
  if (
    scope.mode === "retrieval" &&
    !annotations.some(
      (a: any) =>
        a?.type === "url_citation" &&
        Number.isSafeInteger(a.start_index) &&
        Number.isSafeInteger(a.end_index) &&
        a.start_index >= 0 &&
        a.end_index > a.start_index &&
        a.end_index <= last.content[0].text.length &&
        calls.some((c: any) => c.action.url === a.url),
    )
  )
    throw Error("seo_meta_candidate_citation");
  return { calls, finalMessage: last };
}
