import { expect, it } from "vitest";
import {
  metaSearchCandidateRequest,
  inspectMetaSearchCandidate,
} from "../src/seo-meta-search-candidate.ts";
import { responseRequest } from "../src/seo-responses.ts";

const raw = () => ({
  id: "resp_fixture",
  status: "completed",
  model: "muse-ember-1.0",
  usage: { input_tokens: 1549, output_tokens: 445 },
  output: [
    { type: "reasoning" },
    {
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "検索します。", annotations: [] }],
    },
    {
      type: "web_search_call",
      id: "ws_fixture",
      status: "completed",
      action: { type: "search", query: "exact query" },
      results: [
        {
          type: "text_result",
          title: "Official",
          url: "https://example.org/docs",
          snippet: "hint",
        },
      ],
    },
    { type: "reasoning" },
    {
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: '{"verdict":"selected"}',
          annotations: [],
        },
      ],
    },
  ],
});

it("translates only the known bounded request and never modifies its input", () => {
  const original = {
    ...responseRequest("instructions", { synthetic: true }, null, true),
    max_tool_calls: 1,
  };
  const before = JSON.stringify(original);
  const candidate = metaSearchCandidateRequest(original);
  expect(JSON.stringify(original)).toBe(before);
  expect(candidate).toMatchObject({
    model: "muse-ember-1.0",
    reasoning: { effort: "medium" },
    tool_choice: "auto",
    max_tool_calls: 1,
    include: ["web_search_call.results"],
  });
  expect(candidate.tools).toEqual([
    { type: "web_search", search_context_size: "low" },
  ]);
  expect(() =>
    metaSearchCandidateRequest({ ...original, max_tool_calls: 4 }),
  ).toThrow();
  expect(() =>
    metaSearchCandidateRequest({ ...original, tools: [{ type: "function" }] }),
  ).toThrow();
  expect(() =>
    metaSearchCandidateRequest({ ...original, max_output_tokens: 6001 }),
  ).toThrow();
});

it("inspects the documented search evidence and exact planned query without inventing an open", () => {
  const fixture = raw();
  const before = JSON.stringify(fixture);
  const inspected = inspectMetaSearchCandidate(fixture, 1, {
    mode: "discovery",
    plannedQueries: ["exact query"],
  });
  expect(inspected.calls[0].results[0].url).toBe("https://example.org/docs");
  expect(inspected.calls[0].action).toEqual({
    type: "search",
    query: "exact query",
  });
  expect(inspected.finalMessage.content[0].text).toBe('{"verdict":"selected"}');
  expect(JSON.stringify(fixture)).toBe(before);
  expect(() =>
    inspectMetaSearchCandidate(fixture, 1, {
      mode: "discovery",
      plannedQueries: ["another query"],
    }),
  ).toThrow();
  expect(() =>
    inspectMetaSearchCandidate(
      {
        ...fixture,
        output: fixture.output.filter((x) => x.type !== "web_search_call"),
      },
      1,
      { mode: "discovery", plannedQueries: ["exact query"] },
    ),
  ).toThrow();
  expect(() =>
    inspectMetaSearchCandidate(
      { ...fixture, output: [...fixture.output, fixture.output[2]] },
      1,
      { mode: "discovery", plannedQueries: ["exact query"] },
    ),
  ).toThrow();
});

it("requires an allowed actual open and a provider citation on the final message", () => {
  const fixture = raw();
  fixture.output[2] = {
    type: "web_search_call",
    id: "ws_open",
    status: "completed",
    action: { type: "open_page", url: "https://example.org/docs" },
    results: [],
  } as any;
  const scope = {
    mode: "retrieval" as const,
    allowedUrls: ["https://example.org/docs"],
  };
  expect(() => inspectMetaSearchCandidate(fixture, 1, scope)).toThrow(
    "seo_meta_candidate_citation",
  );
  fixture.output[4].content![0].text = "根拠あり。";
  fixture.output[4].content![0].annotations = [
    {
      type: "url_citation",
      url: "https://example.org/docs",
      start_index: 0,
      end_index: 3,
    },
  ] as any;
  expect(inspectMetaSearchCandidate(fixture, 1, scope).calls).toHaveLength(1);
  expect(() =>
    inspectMetaSearchCandidate(fixture, 1, {
      mode: "retrieval",
      allowedUrls: ["https://example.org/other"],
    }),
  ).toThrow();
  fixture.output[4].content![0].annotations = [
    {
      type: "url_citation",
      url: "https://example.org/docs",
      start_index: 2,
      end_index: 200,
    },
  ] as any;
  expect(() => inspectMetaSearchCandidate(fixture, 1, scope)).toThrow();
});
