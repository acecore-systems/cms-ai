import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { it, expect } from "vitest";
import {
  externalScope,
  externalExistingUrls,
  isNewExternalUrl,
} from "../src/seo-external-sources.ts";
import {
  parseDiscovery,
  assertDiscovery,
  buildDiscoveryRequest,
} from "../src/seo-discovery.ts";
import { buildPlanRequest } from "../src/seo-checks.ts";
import {
  parsePlan,
  researchInputs,
  focusedInput,
} from "../src/seo-research-plan.ts";
import { sha256 } from "../src/seo-hash.ts";
const source = {
  path: "src/content/stories/example.md",
  content:
    "---\ntitle: Example\n---\nOriginal product supports both supported editions.\n\n[Home](/) [Other](../other/) [Doc][ref]\n\n[ref]: //docs.example.org/already#section\n\n<https://docs.example.org/auto>",
};
const scope = externalScope("portal", source);
async function fixture(urls: string[], selected: string | null) {
  const hash = await sha256(source.content),
    claim = researchInputs(source.content).claims[0];
  const plan = parsePlan(
    {
      verdict: "ready",
      claimId: claim.id,
      targetQuote: claim.markdown,
      conditions: [claim.markdown],
      anchors: ["Original"],
      queries: ["Original official documentation"],
    },
    source.content,
    hash,
    2,
  );
  const result = {
    id: "resp_external",
    status: "completed",
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: {
          type: "search",
          queries: plan.queries,
          sources: urls.map((url) => ({ type: "url", url })),
        },
      },
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              verdict: selected ? "selected" : "insufficient",
              selectedUrl: selected,
              reason: "Synthetic primary document candidate",
            }),
            annotations: [],
          },
        ],
      },
    ],
  };
  return { plan, result, raw: JSON.stringify(result) };
}
it("binds canonical JA base, exact configured hosts and relative/reference/autolink identities", () => {
  expect(scope.sourceUrl).toBe("https://asv.acecore.net/stories/example/");
  expect(externalExistingUrls(source.content, scope)).toEqual(
    expect.arrayContaining([
      "https://asv.acecore.net/",
      "https://asv.acecore.net/stories/other/",
      "https://docs.example.org/already",
      "https://docs.example.org/auto",
    ]),
  );
  expect(
    isNewExternalUrl("https://asv.acecore.net/new", source.content, scope),
  ).toBe(false);
  expect(
    isNewExternalUrl(
      "https://asv.acecore.net.attacker.org/new",
      source.content,
      scope,
    ),
  ).toBe(true); // not an ownership/officialness endorsement
  expect(
    isNewExternalUrl("https://docs.example.org/new", source.content, scope),
  ).toBe(true);
  expect(() =>
    externalScope("portal", {
      ...source,
      path: "src/content/stories/en/example.md",
    }),
  ).toThrow("seo_external_scope");
});
it.each([
  "https://asv.acecore.net/",
  "https://asv.acecore.net/new",
  "https://docs.example.org/already",
  "https://docs.example.org/auto",
  "https://asv.acecore.net@docs.example.org/already",
  "http://127.0.0.1/private",
])("known source exclusion ends insufficient for %s", async (url) => {
  const { result, plan, raw } = await fixture([url], url);
  await expect(
    parseDiscovery(result, source.content, plan, raw, 4, scope),
  ).rejects.toThrow("seo_research_insufficient");
});
it("v4 keeps exact raw URL, rationale and scope; rejects replay under a different source origin", async () => {
  const url = "https://docs.example.org/new",
    { result, plan, raw } = await fixture(
      ["https://asv.acecore.net/", url],
      url,
    );
  const parsed = await parseDiscovery(
    result,
    source.content,
    plan,
    raw,
    4,
    scope,
  );
  expect(parsed.selectedUrl).toBe(url);
  expect(parsed.urls).toEqual([url]);
  expect(parsed.selectionReason).toBe("Synthetic primary document candidate");
  expect(parsed.responseSha256).toBe(await sha256(raw));
  await expect(
    assertDiscovery(parsed, source.content, plan, raw, scope),
  ).resolves.toBeUndefined();
  await expect(
    assertDiscovery(parsed, source.content, plan, raw, {
      ...scope,
      sourceUrl: "https://other.example.org/stories/example/",
    }),
  ).rejects.toThrow();
  await expect(
    parseDiscovery(result, source.content, plan, raw, 4),
  ).rejects.toThrow("seo_external_scope");
});
it("cannot invent a selected URL absent from raw search even when it is external", async () => {
  const { result, plan, raw } = await fixture(
    ["https://docs.example.org/new"],
    "https://docs.example.org/forged",
  );
  await expect(
    parseDiscovery(result, source.content, plan, raw, 4, scope),
  ).rejects.toThrow("seo_check_evidence");
});
it.each([1, 2, 3] as const)(
  "old v%s still permits the prior same-site result and replays unchanged",
  async (version) => {
    const { result, plan, raw } = await fixture(
      ["https://asv.acecore.net/"],
      "https://asv.acecore.net/",
    );
    const parsed = await parseDiscovery(
      result,
      source.content,
      plan,
      raw,
      version,
    );
    expect(parsed.selectedUrl).toBe("https://asv.acecore.net/");
    expect(parsed.externalScope).toBeUndefined();
    await expect(
      assertDiscovery(parsed, source.content, plan, raw),
    ).resolves.toBeUndefined();
  },
);
it("only new planner/discovery requests receive scope; no claim/context or condition is removed", async () => {
  const { plan } = await fixture(
    ["https://docs.example.org/new"],
    "https://docs.example.org/new",
  );
  const old = buildPlanRequest(source.content, 2, 3),
    next = buildPlanRequest(source.content, 2, 4, scope);
  expect(JSON.parse(next.input).claims).toEqual(JSON.parse(old.input).claims);
  expect(next.instructions).toContain("固有の自サービス");
  expect(JSON.parse(old.input).externalScope).toBeUndefined();
  const focused = focusedInput(source.content, plan.sourceSha256, plan),
    request = buildDiscoveryRequest(focused, 4, scope),
    input = JSON.parse(request.input);
  expect(input.plan).toEqual(focused.plan);
  expect(input.existingUrls).toContain("https://asv.acecore.net/");
  expect(input.existingUrls).not.toContain("/");
  expect(request.max_tool_calls).toBe(1);
  expect(buildDiscoveryRequest(focused, 3).input).toBe(JSON.stringify(focused));
});
it("new immutable opt-in leaves all legacy job columns unchanged", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE seo_editorial_jobs(id TEXT,discovery_policy INTEGER);INSERT INTO seo_editorial_jobs VALUES('old',3)",
    );
    db.exec(
      readFileSync(
        new URL("../migrations/0016_seo_external_sources.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(db.prepare("SELECT * FROM seo_editorial_jobs").get()).toEqual({
      id: "old",
      discovery_policy: 3,
      external_sources: 0,
    });
    expect(() =>
      db.exec("UPDATE seo_editorial_jobs SET external_sources=1"),
    ).toThrow("immutable_external_sources");
  } finally {
    db.close();
  }
});
