import { expect, it, vi } from "vitest";
import {
  parallelCandidates,
  parallelSearch,
} from "../src/seo-parallel-search.ts";

const scope = {
  sourceUrl: "https://acecore.net/blog/source/",
  excludedHosts: ["acecore.net"],
};
const source = "---\ntitle: Test\n---\n\nBody.";
const answer = () => ({
  jsonrpc: "2.0",
  id: 2,
  result: {
    structuredContent: {
      search_id: "search_fixture",
      results: [
        {
          url: "https://playwright.dev/docs/intro",
          title: "Official",
          excerpts: ["excerpt"],
        },
        { url: "https://example.org/unsafe", title: "Other", excerpts: [] },
      ],
      warnings: null,
      session_id: "fixture",
    },
  },
});

it("permits only exact new URLs from the fixed publisher allowlist", () => {
  expect(parallelCandidates(answer(), source, scope)).toEqual([
    {
      url: "https://playwright.dev/docs/intro",
      title: "Official",
      excerpts: ["excerpt"],
    },
  ]);
  expect(
    parallelCandidates(
      answer(),
      source + " [existing](https://playwright.dev/docs/intro)",
      scope,
    ),
  ).toEqual([]);
  expect(
    parallelCandidates(answer(), source, {
      ...scope,
      excludedHosts: ["playwright.dev"],
    }),
  ).toEqual([]);
  const bad = answer();
  bad.result.structuredContent.results[0].excerpts = ["x".repeat(5001)];
  expect(() => parallelCandidates(bad, source, scope)).toThrow();
});

it("uses one fixed anonymous MCP search with an initialization handshake and no retries", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "fixture-session",
        },
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 202 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify(answer()), {
        headers: { "content-type": "application/json" },
      }),
    );
  const data = await parallelSearch(
    ["Playwright documentation"],
    "seo-00000000-0000-4000-8000-000000000001",
    Date.now() + 30000,
    fetcher,
  );
  expect(data.value).toEqual(answer());
  expect(data.raw).toBe(JSON.stringify(answer()));
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(
    fetcher.mock.calls.every(
      ([url, init]) =>
        url === "https://search.parallel.ai/mcp" &&
        init.redirect === "manual" &&
        !init.headers.authorization,
    ),
  ).toBe(true);
  expect(
    JSON.parse(fetcher.mock.calls[2][1].body).params.arguments.search_queries,
  ).toEqual(["Playwright documentation"]);
  expect(() =>
    parallelCandidates({ ...answer(), error: {} }, source, scope),
  ).toThrow();
});
