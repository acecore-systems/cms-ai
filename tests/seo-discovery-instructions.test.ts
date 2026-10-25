import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { buildDiscoveryRequest, parseDiscovery } from "../src/seo-discovery.ts";
import { externalScope } from "../src/seo-external-sources.ts";
import { parsePlan, focusedInput } from "../src/seo-research-plan.ts";
import { sha256 } from "../src/seo-hash.ts";

async function fixture() {
  // Synthetic minimal reproduction, not the private trial response or live support.
  const source = {
    path: "src/content/insights/example.md",
    content:
      "---\ntitle: Synthetic\n---\nPageSpeedのスコアは線形ではありません。\n",
  };
  const hash = await sha256(source.content);
  const plan = parsePlan(
    {
      verdict: "ready",
      claimId: "claim-1",
      targetQuote: "PageSpeedのスコアは線形ではありません。",
      conditions: ["PageSpeedのスコアは線形ではありません。"],
      anchors: ["PageSpeedのスコア"],
      queries: [
        "PageSpeedのスコアは線形ではありません Lighthouse score curve official Google",
      ],
    },
    source.content,
    hash,
    2,
    2,
  );
  const scope = externalScope("acecore-systems", source);
  const url =
    "https://github.com/GoogleChrome/lighthouse/blob/main/docs/scoring.md";
  const response = {
    id: "resp_synthetic_trial8",
    status: "completed",
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: {
          type: "search",
          queries: plan.queries,
          sources: [{ type: "url", url }],
        },
      },
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            annotations: [],
            text: JSON.stringify({
              verdict: "insufficient",
              selectedUrl: null,
              fallbackUrl: null,
              reason:
                "The search surfaced relevant Lighthouse scoring documents, but their snippets are only relevance hints and cannot verify support for the full PageSpeed claim.",
            }),
          },
        ],
      },
    ],
  };
  return {
    source,
    plan,
    scope,
    url,
    response,
    focused: focusedInput(source.content, hash, plan),
  };
}
it("new instructions separate candidate relevance from body support without altering the search or output contract", async () => {
  const f = await fixture();
  const old = buildDiscoveryRequest(f.focused, 5, f.scope, 2, 2);
  expect(buildDiscoveryRequest(f.focused, 5, f.scope, 2, 2, 1)).toEqual(old);
  const next = buildDiscoveryRequest(f.focused, 5, f.scope, 2, 2, 2);
  expect({ ...next, instructions: old.instructions }).toEqual(old);
  expect(next.instructions).toContain("Do not return insufficient SOLELY");
  expect(next.instructions).toContain(
    "ENTIRE fixed quote and ALL requiredConditions",
  );
  expect(next.instructions).toContain(
    "Return insufficient when no candidate meets both selection requirements",
  );
  expect(next.max_tool_calls).toBe(1);
  for (const bad of [0, 3])
    expect(() =>
      buildDiscoveryRequest(f.focused, 5, f.scope, 2, 2, bad),
    ).toThrow("seo_discovery_instructions");
  expect(() => buildDiscoveryRequest(f.focused, 4, f.scope, 2, 2, 2)).toThrow(
    "seo_discovery_instructions",
  );
});
it("preserves the failed trial verdict; a synthetic selection only permits retrieval, never proves support", async () => {
  const f = await fixture();
  const parse = () =>
    parseDiscovery(
      f.response,
      f.source.content,
      f.plan,
      JSON.stringify(f.response),
      5,
      f.scope,
      2,
    );
  await expect(parse()).rejects.toThrow("seo_research_insufficient");
  const message = f.response.output[1].content![0];
  message.text = JSON.stringify({
    verdict: "selected",
    selectedUrl: f.url,
    fallbackUrl: null,
    reason: "Synthetic relevance selection; body support is unknown.",
  });
  expect((await parse()).selectedUrl).toBe(f.url);
  message.text = JSON.stringify({
    verdict: "selected",
    selectedUrl:
      "https://developer.chrome.com/docs/lighthouse/performance/performance-scoring",
    fallbackUrl: null,
    reason: "Do not follow an unseen redirect or substitute URL.",
  });
  await expect(parse()).rejects.toThrow();
  message.text = JSON.stringify({
    verdict: "insufficient",
    selectedUrl: null,
    fallbackUrl: null,
    reason: "All results concern a different condition or topic.",
  });
  await expect(parse()).rejects.toThrow("seo_research_insufficient");
});
it("0023 preserves every old table row, column and trigger and defaults old jobs to immutable instruction 1", () => {
  const db = new DatabaseSync(":memory:");
  const root = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(root)
    .filter((x) => /^\d+_seo/.test(x) && x < "0023")
    .sort())
    db.exec(readFileSync(new URL(file, root), "utf8"));
  db.exec(
    "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at) VALUES('old','budget','hash',1,'[]',0); INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index,research_recovery) VALUES('oldjob','old','site',0,2)",
  );
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name as string);
  const rows = Object.fromEntries(
    tables.map((t) => [t, db.prepare(`SELECT * FROM ${t}`).all()]),
  );
  const triggers = db
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
    )
    .all();
  db.exec(
    readFileSync(new URL("0023_seo_discovery_instructions.sql", root), "utf8"),
  );
  for (const t of tables)
    expect(db.prepare(`SELECT * FROM ${t}`).all()).toEqual(
      t === "seo_editorial_jobs"
        ? rows[t].map((r) => ({ ...r, discovery_instructions: 1 }))
        : rows[t],
    );
  expect(
    db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name!='seo_discovery_instructions_immutable' ORDER BY name",
      )
      .all(),
  ).toEqual(triggers);
  expect(() =>
    db.exec("UPDATE seo_editorial_jobs SET discovery_instructions=2"),
  ).toThrow("immutable_discovery_instructions");
  db.exec(
    "INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index,discovery_instructions) VALUES('newjob','old','site',1,2)",
  );
  expect(
    db
      .prepare(
        "SELECT discovery_instructions FROM seo_editorial_jobs WHERE id='newjob'",
      )
      .get()!.discovery_instructions,
  ).toBe(2);
  db.close();
});

it("asks for a content-specific primary candidate rather than trusting a brand homepage", async () => {
  const f = await fixture();
  const request = buildDiscoveryRequest(f.focused, 5, f.scope, 2, 2, 2);
  expect(request.instructions).toContain(
    "concrete documentation page covering the required feature/section over a generic brand homepage",
  );
  expect(request.instructions).toContain(
    "publisher/project ownership or documentation linkage",
  );
  expect(request.instructions).toContain(
    "not a product-like domain name or 'official' label alone",
  );
  expect(request.instructions).toContain(
    "if authority is unknown, return insufficient",
  );
  expect(request.instructions).toContain(
    "do not invent a deeper path or append a section fragment",
  );
  const homepage = "https://example.org/";
  f.response.output[0].action!.sources!.unshift({ type: "url", url: homepage });
  const message = f.response.output[1].content![0];
  const parse = () =>
    parseDiscovery(
      f.response,
      f.source.content,
      f.plan,
      JSON.stringify(f.response),
      5,
      f.scope,
      2,
    );
  message.text = JSON.stringify({
    verdict: "selected",
    selectedUrl: f.url,
    fallbackUrl: null,
    reason:
      "Synthetic publisher-owned repository documentation; scoring section is relevant. Brand homepage alone does not establish authority or full relevance.",
  });
  expect((await parse()).selectedUrl).toBe(f.url);
  // A model's unknown-authority verdict is never upgraded by domain branding.
  message.text = JSON.stringify({
    verdict: "insufficient",
    selectedUrl: null,
    fallbackUrl: null,
    reason:
      "Only a brand-like homepage remains; publisher authority is unknown.",
  });
  await expect(parse()).rejects.toThrow("seo_research_insufficient");
  for (const unseen of [f.url + "#scoring", f.url + "/details"]) {
    message.text = JSON.stringify({
      verdict: "selected",
      selectedUrl: unseen,
      fallbackUrl: null,
      reason: "Invented section location",
    });
    await expect(parse()).rejects.toThrow();
  }
});
