import { it, expect } from "vitest";
import { parseDiscovery, assertDiscovery } from "../src/seo-discovery.ts";
import {
  parsePlan,
  researchInputs,
  factualSentences,
} from "../src/seo-research-plan.ts";
import { parseResearch, buildRetrievalRequest } from "../src/seo-checks.ts";
import { focusedInput } from "../src/seo-research-plan.ts";
import { sha256 } from "../src/seo-hash.ts";
const source =
  "---\ntitle: Test\n---\nOriginal product supports verified configuration settings.\n\n[Existing](https://docs.example.org/existing)";
async function fixture() {
  const hash = await sha256(source);
  const claim = researchInputs(source).claims[0],
    quote = factualSentences(claim.markdown)[0].quote;
  const plan = parsePlan(
    {
      verdict: "ready",
      claimId: claim.id,
      targetQuote: quote,
      conditions: [quote],
      anchors: ["Original"],
      queries: ["Original official documentation"],
    },
    source,
    hash,
    2,
  );
  const value = {
    id: "resp_discovery",
    status: "completed",
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: {
          type: "search",
          queries: plan.queries,
          sources: [{ type: "url", url: "https://docs.example.org/new" }],
        },
      },
    ],
  };
  return { hash, plan, value };
}
it("binds selected exact URL and ordered results to original response bytes, not JSON reserialization", async () => {
  const { plan, value } = await fixture();
  const raw = JSON.stringify(value, null, 2);
  const selected = await parseDiscovery(value, source, plan, raw);
  expect(selected.responseSha256).toBe(await sha256(raw));
  expect(selected.responseSha256).not.toBe(await sha256(JSON.stringify(value)));
  await expect(
    assertDiscovery(selected, source, plan),
  ).resolves.toBeUndefined();
  await expect(parseDiscovery(value, source, plan, "{}")).rejects.toThrow(
    "seo_check_evidence",
  );
  expect(selected.selectedUrl).toBe(value.output[0].action.sources[0].url);
  const request = buildRetrievalRequest(
    focusedInput(source, selected.sourceSha256, plan),
    selected,
  );
  expect(request.max_tool_calls).toBe(1);
  expect(JSON.parse(request.input).discovery.responseSha256).toBe(
    selected.responseSha256,
  );
});
it("replays v1 unchanged while v2 prefers a registered publisher from the exact raw set", async () => {
  const { plan, value } = await fixture();
  const official = "https://playwright.dev/docs/intro";
  value.output[0].action.sources.push({ type: "url", url: official });
  const raw = JSON.stringify(value);
  const old = await parseDiscovery(value, source, plan, raw, 1);
  const current = await parseDiscovery(value, source, plan, raw, 2);
  expect(old.selectedUrl).toBe("https://docs.example.org/new");
  expect(current.selectedUrl).toBe(official);
  expect(current.urls).toEqual(old.urls);
  expect(current.responseSha256).toBe(old.responseSha256);
  await expect(assertDiscovery(old, source, plan)).resolves.toBeUndefined();
  await expect(assertDiscovery(current, source, plan)).resolves.toBeUndefined();
  await expect(
    assertDiscovery({ ...old, version: 2 }, source, plan),
  ).rejects.toThrow();
  await expect(
    assertDiscovery(
      { ...current, selectedUrl: "https://playwright.dev/docs/other" },
      source,
      plan,
    ),
  ).rejects.toThrow();
});
it.each(["mirror", "not-opened", "second-search", "no-citation"])(
  "rejects retrieval outside the fixed discovery contract: %s",
  async (kind) => {
    const { plan, value, hash } = await fixture();
    const discovery = await parseDiscovery(
      value,
      source,
      plan,
      JSON.stringify(value),
    );
    const url =
      kind === "mirror"
        ? "https://mirror.example.org/new"
        : discovery.selectedUrl!;
    const result = {
      id: "resp_retrieval",
      status: "completed",
      output: [
        {
          type: "web_search_call",
          status: "completed",
          action:
            kind === "not-opened"
              ? { type: "search", queries: plan.queries, sources: [] }
              : { type: "open_page", url },
        },
        {
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text:
                "Verified claim [1].\n```json\n" +
                JSON.stringify({
                  verdict: "verified",
                  sources: [
                    {
                      url,
                      title: "Primary guide",
                      claimId: plan.claimId,
                      excerpt:
                        "Primary documentation supports this entire factual configuration statement.",
                      assessment: "supports",
                    },
                  ],
                }) +
                "\n```",
              annotations:
                kind === "no-citation"
                  ? []
                  : [
                      {
                        type: "url_citation",
                        url,
                        start_index: 15,
                        end_index: 18,
                      },
                    ],
            },
          ],
        },
      ],
    };
    if (kind === "second-search") result.output.push(value.output[0] as any);
    expect(() =>
      parseResearch(result, source, hash, Date.now(), plan, discovery),
    ).toThrow();
  },
);
