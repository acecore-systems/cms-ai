import { preferredPublisher } from "./seo-publishers.ts";
import {
  isNewExternalUrl,
  type ExternalScope,
} from "./seo-external-sources.ts";

const ENDPOINT = "https://search.parallel.ai/mcp";
const LIMIT = 128 * 1024;
export const parallelSearchEnvelope = (
  queries: string[],
  sessionId: string,
) => ({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: {
    name: "web_search",
    arguments: {
      objective:
        "Find primary documentation relevant to the exact provided search queries.",
      search_queries: queries,
      session_id: sessionId,
    },
  },
});

async function boundedJson(response: Response) {
  if (
    !response.ok ||
    response.redirected ||
    !/^application\/json(?:;|$)/i.test(
      response.headers.get("content-type") || "",
    ) ||
    !response.body
  )
    throw Error("seo_parallel_response");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > LIMIT) throw Error("seo_parallel_size");
      parts.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    all,
  );
  return { raw, value: JSON.parse(raw) };
}

export function parallelCandidates(
  raw: any,
  source: string,
  scope: ExternalScope,
  referencePolicy = 1,
) {
  const result = raw?.result?.structuredContent;
  if (
    raw?.jsonrpc !== "2.0" ||
    raw?.id !== 2 ||
    raw?.error ||
    raw?.result?.isError ||
    typeof result?.search_id !== "string" ||
    !/^search_[A-Za-z0-9_-]{1,120}$/.test(result.search_id) ||
    !Array.isArray(result.results) ||
    result.results.length > 30 ||
    (result.warnings !== null &&
      result.warnings !== undefined &&
      (!Array.isArray(result.warnings) || result.warnings.length > 0))
  )
    throw Error("seo_parallel_shape");
  return result.results.flatMap((item: any) => {
    if (
      typeof item?.url !== "string" ||
      typeof item.title !== "string" ||
      item.title.length > 500 ||
      !Array.isArray(item.excerpts) ||
      item.excerpts.length > 10 ||
      item.excerpts.some((x: any) => typeof x !== "string" || x.length > 5000)
    )
      throw Error("seo_parallel_shape");
    if (
      !preferredPublisher(item.url) ||
      !isNewExternalUrl(item.url, source, scope, referencePolicy)
    )
      return [];
    return [{ url: item.url, title: item.title, excerpts: item.excerpts }];
  });
}

// One initialized, anonymous MCP session and one web_search call. There is no
// retry on an uncertain outcome. Callers persist and hash the exact response.
export async function parallelSearch(
  queries: string[],
  sessionId: string,
  deadline: number,
  fetcher: typeof fetch = fetch,
) {
  if (
    !Array.isArray(queries) ||
    queries.length < 1 ||
    queries.length > 2 ||
    queries.some(
      (q) =>
        typeof q !== "string" ||
        !q.trim() ||
        q.length > 500 ||
        /https?:\/\//i.test(q),
    ) ||
    !/^seo-[0-9a-f-]{36}$/.test(sessionId) ||
    !Number.isSafeInteger(deadline) ||
    Date.now() >= deadline
  )
    throw Error("seo_parallel_request");
  const send = async (payload: unknown, session?: string) => {
    if (Date.now() >= deadline) throw Error("seo_parallel_deadline");
    return fetcher(ENDPOINT, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(15000, deadline - Date.now())),
      ),
    });
  };
  const init = await send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "cms-seo", version: "1" },
    },
  });
  const session = init.headers.get("mcp-session-id");
  const initialized = (await boundedJson(init)).value;
  if (
    !session ||
    !/^[A-Za-z0-9._~-]{1,256}$/.test(session) ||
    initialized?.jsonrpc !== "2.0" ||
    initialized?.id !== 1 ||
    !initialized?.result ||
    initialized?.error
  )
    throw Error("seo_parallel_initialize");
  const ack = await send(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    session,
  );
  if (!ack.ok || ack.redirected) throw Error("seo_parallel_initialize");
  await ack.body?.cancel();
  const searchRequest = parallelSearchEnvelope(queries, sessionId);
  const response = await send(searchRequest, session);
  return {
    request: JSON.stringify(searchRequest),
    ...(await boundedJson(response)),
  };
}
