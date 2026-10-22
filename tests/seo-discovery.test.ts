import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { it, expect } from "vitest";
import {
  parseDiscovery,
  assertDiscovery,
  buildDiscoveryRequest,
} from "../src/seo-discovery.ts";
import {
  parsePlan,
  researchInputs,
  factualSentences,
} from "../src/seo-research-plan.ts";
import {
  parseResearch,
  buildRetrievalRequest,
  buildPlanRequest,
} from "../src/seo-checks.ts";
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

const message = (text: string) => ({
  type: "message",
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }],
});
it("v3 chooses relevance from the exact set instead of overriding with publisher rank; raw replay is mandatory", async () => {
  const { plan, value } = await fixture();
  const hangar = "https://hangar.papermc.io/GeyserMC/Floodgate",
    linking = "https://geysermc.org/wiki/floodgate/linking/";
  value.output[0].action.sources = [
    { type: "url", url: hangar },
    { type: "url", url: linking },
  ];
  const result = {
    ...value,
    output: [
      ...value.output,
      message(
        JSON.stringify({
          verdict: "selected",
          selectedUrl: hangar,
          reason:
            "Synthetic relevance selection: account-free participation, not linking",
        }),
      ),
    ],
  };
  const raw = JSON.stringify(result, null, 2);
  expect((await parseDiscovery(result, source, plan, raw, 2)).selectedUrl).toBe(
    linking,
  );
  const selected = await parseDiscovery(result, source, plan, raw, 3);
  expect(selected.selectedUrl).toBe(hangar);
  await expect(
    assertDiscovery(selected, source, plan, raw),
  ).resolves.toBeUndefined();
  await expect(assertDiscovery(selected, source, plan)).rejects.toThrow();
  await expect(
    assertDiscovery({ ...selected, selectedUrl: linking }, source, plan, raw),
  ).rejects.toThrow();
  await expect(
    assertDiscovery(
      { ...selected, selectionReason: "changed" },
      source,
      plan,
      raw,
    ),
  ).rejects.toThrow();
});
it.each([
  "outside",
  "existing",
  "unsafe",
  "missing",
  "extra",
  "fenced",
  "prefix",
  "suffix",
  "multiple",
  "omitted",
  "empty-reason",
  "bad-insufficient",
  "duplicate",
])("v3 rejects ambiguous or invalid selection: %s", async (kind) => {
  const { plan, value } = await fixture();
  let v: any = {
    verdict: "selected",
    selectedUrl: "https://docs.example.org/new",
    reason: "Relevant candidate",
  };
  if (kind === "outside") v.selectedUrl = "https://mirror.example.org/new";
  if (kind === "existing") v.selectedUrl = "https://docs.example.org/existing";
  if (kind === "unsafe") v.selectedUrl = "http://127.0.0.1/";
  if (kind === "missing") delete v.selectedUrl;
  if (kind === "extra") v.supports = true;
  if (kind === "empty-reason") v.reason = " ";
  if (kind === "bad-insufficient") v.verdict = "insufficient";
  let text = JSON.stringify(v);
  if (kind === "fenced") text = "```json\n" + text + "\n```";
  if (kind === "prefix") text = "Selected: " + text;
  if (kind === "suffix") text += " {}";
  if (kind === "duplicate")
    text = text.replace('{"verdict":', '{"verdict":"insufficient","verdict":');
  const output: any[] = [
    ...value.output,
    ...(kind === "omitted" ? [] : [message(text)]),
    ...(kind === "multiple" ? [message(text)] : []),
  ];
  const r = { ...value, output };
  await expect(
    parseDiscovery(r, source, plan, JSON.stringify(r), 3),
  ).rejects.toThrow();
});
it("v3 explicit insufficiency is a known rejection; old search builders remain unchanged", async () => {
  const { plan, value } = await fixture();
  const r = {
    ...value,
    output: [
      ...value.output,
      message(
        JSON.stringify({
          verdict: "insufficient",
          selectedUrl: null,
          reason: "Topic mismatch",
        }),
      ),
    ],
  };
  await expect(
    parseDiscovery(r, source, plan, JSON.stringify(r), 3),
  ).rejects.toThrow("seo_research_insufficient");
  const focused = focusedInput(source, plan.sourceSha256, plan);
  expect(buildDiscoveryRequest(focused, 1)).toEqual(
    buildDiscoveryRequest(focused, 2),
  );
  expect(buildDiscoveryRequest(focused, 3).max_tool_calls).toBe(1);
  expect(buildDiscoveryRequest(focused, 3).instructions).not.toEqual(
    buildDiscoveryRequest(focused, 2).instructions,
  );
});

it("keeps the sanitized actual Portal text incompatible with v3 instead of manufacturing a verified response", async () => {
  const excerpt = JSON.parse(
    readFileSync(
      new URL("./fixtures/seo-discovery-portal-excerpt.json", import.meta.url),
      "utf8",
    ),
  );
  const { plan, value } = await fixture();
  value.output[0].action.sources = excerpt.urls.map((url: string) => ({
    type: "url",
    url,
  }));
  const result = { ...value, output: [...value.output, message(excerpt.text)] },
    raw = JSON.stringify(result);
  expect(excerpt.text).toContain("Hangar");
  expect((await parseDiscovery(result, source, plan, raw, 2)).selectedUrl).toBe(
    "https://geysermc.org/wiki/floodgate/linking/",
  );
  await expect(parseDiscovery(result, source, plan, raw, 3)).rejects.toThrow();
});
it("migration retains every old job column, defaults to policy2 and makes policy immutable", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE seo_editorial_jobs(id TEXT PRIMARY KEY,status TEXT,nullable TEXT); INSERT INTO seo_editorial_jobs VALUES('old','unresolved',NULL)",
  );
  const before = db.prepare("SELECT * FROM seo_editorial_jobs").all();
  db.exec(
    readFileSync(
      new URL("../migrations/0013_seo_discovery_policy.sql", import.meta.url),
      "utf8",
    ),
  );
  expect(
    db.prepare("SELECT id,status,nullable FROM seo_editorial_jobs").all(),
  ).toEqual(before);
  expect(
    db.prepare("SELECT discovery_policy FROM seo_editorial_jobs").get()!
      .discovery_policy,
  ).toBe(2);
  expect(() =>
    db.exec("UPDATE seo_editorial_jobs SET discovery_policy=3 WHERE id='old'"),
  ).toThrow("immutable_discovery_policy");
  db.exec(
    "INSERT INTO seo_editorial_jobs(id,status,discovery_policy) VALUES('new','pending',3)",
  );
  expect(() =>
    db.exec("UPDATE seo_editorial_jobs SET discovery_policy=2 WHERE id='new'"),
  ).toThrow();
  db.close();
});

it("keeps legacy planner payload unchanged and only adds named-entity guidance for policy3", () => {
  expect(buildPlanRequest(source, 2)).toEqual(buildPlanRequest(source, 2, 2));
  const old = buildPlanRequest(source, 2, 2),
    current = buildPlanRequest(source, 2, 3);
  expect(current.instructions.startsWith(old.instructions)).toBe(true);
  expect({ ...current, instructions: old.instructions }).toEqual(old);
  expect(current.instructions).toContain("固有名詞");
});
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { responsesUpperCost } from "../src/seo-responses.ts";

it("only retrieval high changes a single tool setting; old default and discovery remain low", async () => {
  const { plan, value } = await fixture();
  const discovery = await parseDiscovery(
    value,
    source,
    plan,
    JSON.stringify(value),
  );
  const focused = focusedInput(source, discovery.sourceSha256, plan);
  const old = buildRetrievalRequest(focused, discovery);
  expect(buildRetrievalRequest(focused, discovery, "low")).toEqual(old);
  const high = buildRetrievalRequest(focused, discovery, "high");
  expect(high.tools?.[0].search_context_size).toBe("high");
  expect(buildDiscoveryRequest(focused).tools?.[0].search_context_size).toBe(
    "low",
  );
  const restored = structuredClone(high);
  restored.tools![0].search_context_size = "low";
  expect(JSON.stringify(restored)).toBe(JSON.stringify(old));
  const now = Date.parse("2026-10-23T00:00:00Z");
  // high is one byte longer than low; same 128k bound and one-tool ceiling.
  expect(
    responsesUpperCost(high, now) - responsesUpperCost(old, now),
  ).toBeLessThanOrEqual(1);
  expect(high.max_tool_calls).toBe(1);
  expect(() => responsesUpperCost({ ...high, max_tool_calls: 3 }, now)).toThrow(
    "seo_research_bound",
  );
  expect(() =>
    responsesUpperCost(
      {
        ...high,
        tools: [{ ...high.tools![0], return_token_budget: "unlimited" }],
      },
      now,
    ),
  ).toThrow("seo_research_bound");
  expect(() =>
    responsesUpperCost(
      {
        ...high,
        tools: [{ ...high.tools![0], search_context_size: "medium" }],
      },
      now,
    ),
  ).toThrow("seo_research_bound");
});
it("context migration preserves every old value and makes old low/new high immutable", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE seo_editorial_jobs(id TEXT, status TEXT); INSERT INTO seo_editorial_jobs VALUES('old','unresolved')",
    );
    db.exec(
      readFileSync(
        new URL("../migrations/0017_seo_research_context.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(db.prepare("SELECT * FROM seo_editorial_jobs").get()).toEqual({
      id: "old",
      status: "unresolved",
      research_context: "low",
    });
    db.exec("INSERT INTO seo_editorial_jobs VALUES('new','pending','high')");
    expect(() =>
      db.exec(
        "UPDATE seo_editorial_jobs SET research_context='high' WHERE id='old'",
      ),
    ).toThrow("immutable_research_context");
    expect(() =>
      db.exec(
        "UPDATE seo_editorial_jobs SET research_context='low' WHERE id='new'",
      ),
    ).toThrow("immutable_research_context");
    expect(() =>
      db.exec(
        "INSERT INTO seo_editorial_jobs VALUES('bad','pending','medium')",
      ),
    ).toThrow();
  } finally {
    db.close();
  }
});
