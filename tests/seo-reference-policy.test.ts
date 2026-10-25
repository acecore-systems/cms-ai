import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { referenceUrl, evidenceReferences } from "../src/seo-evidence.ts";
import {
  parseDiscovery,
  assertDiscovery,
  buildDiscoveryRequest,
} from "../src/seo-discovery.ts";
import {
  parseResearch,
  buildRetrievalRequest,
  loadResearch,
} from "../src/seo-checks.ts";
import { externalScope } from "../src/seo-external-sources.ts";
import {
  parsePlan,
  researchInputs,
  focusedInput,
} from "../src/seo-research-plan.ts";
import { sha256 } from "../src/seo-hash.ts";
const url =
  "https://learn.microsoft.com/en-us/minecraft/creator/documents/bedrockserver/getting-started?view=minecraft-bedrock-stable";
const source = {
  path: "src/content/stories/example.md",
  content:
    "---\ntitle: Example\n---\nBedrock Dedicated Server supports the documented platforms.",
};
async function fixture() {
  const hash = await sha256(source.content),
    claim = researchInputs(source.content).claims[0];
  const plan = parsePlan(
    {
      verdict: "ready",
      claimId: claim.id,
      targetQuote: claim.markdown,
      conditions: [claim.markdown],
      anchors: ["Bedrock"],
      queries: ["Bedrock official documentation"],
    },
    source.content,
    hash,
    2,
  );
  const result = {
    id: "resp_fixture",
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
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              verdict: "selected",
              selectedUrl: url,
              reason:
                "Relevant official documentation candidate; verification remains required.",
            }),
            annotations: [],
          },
        ],
      },
    ],
  };
  return { hash, plan, result, scope: externalScope("portal", source) };
}
it("only policy2 accepts the exact fixed Learn view without normalization", () => {
  expect(() => referenceUrl(url)).toThrow();
  expect(referenceUrl(url, 2)).toBe(url);
  expect(
    referenceUrl(url.replace("getting-started", "another-document"), 2),
  ).toContain("another-document");
  expect(() => referenceUrl(url, 3)).toThrow();
});
it.each([
  url + "&token=secret",
  url + "&view=minecraft-bedrock-stable",
  url + "#section",
  url + "&",
  url.replace("view=", "%76iew="),
  url.replace("stable", "%73table"),
  url.replace("stable", "preview"),
  url.replace("stable", "stable%00"),
  url.replace("learn.microsoft.com", "learn.microsoft.com.evil.org"),
  url.replace("learn.microsoft.com", "x.learn.microsoft.com"),
  url.replace("https:", "http:"),
  url.replace("learn.microsoft.com", "user@learn.microsoft.com"),
  url.replace("learn.microsoft.com", "learn.microsoft.com:443"),
  url.replace("/en-us/", "/ja-jp/"),
  url.replace("/documents/", "/documents-other/"),
  url.replace("/documents/", "/documents/../documents/"),
  url.replace("/documents/", "/documents/%2e%2e/documents/"),
  url.replace("/documents/", "/documents//"),
  url.replace("/documents/", "/documents%2f"),
  url.replace("view=", "token="),
  url.replace("?view=", "?view=x&view="),
  url.replace("learn.microsoft.com", "LEARN.microsoft.com"),
  url + "\n",
])("rejects encoded/ambiguous/unapproved URL %s", (value) => {
  expect(() => referenceUrl(value, 2)).toThrow();
});
it("keeps v4 old rejection, source membership and self/existing exclusions; new policy can replay exact discovery", async () => {
  const f = await fixture(),
    raw = JSON.stringify(f.result);
  await expect(
    parseDiscovery(f.result, source.content, f.plan, raw, 4, f.scope),
  ).rejects.toThrow("seo_research_insufficient");
  const d = await parseDiscovery(
    f.result,
    source.content,
    f.plan,
    raw,
    4,
    f.scope,
    2,
  );
  expect(d.selectedUrl).toBe(url);
  expect(d.referencePolicy).toBe(2);
  await assertDiscovery(d, source.content, f.plan, raw, f.scope);
  expect(d.responseSha256).toBe(await sha256(raw));
  await expect(
    parseDiscovery(
      f.result,
      source.content + "\n[Already](" + url + ")",
      f.plan,
      raw,
      4,
      f.scope,
      2,
    ),
  ).rejects.toThrow();
  await expect(
    parseDiscovery(
      f.result,
      source.content,
      f.plan,
      raw,
      4,
      { ...f.scope, excludedHosts: ["learn.microsoft.com"] },
      2,
    ),
  ).rejects.toThrow();
  const foreign = structuredClone(f.result);
  foreign.output[0].action!.sources = [];
  await expect(
    parseDiscovery(
      foreign,
      source.content,
      f.plan,
      JSON.stringify(foreign),
      4,
      f.scope,
      2,
    ),
  ).rejects.toThrow();
});
it("keeps old payloads byte-identical and aligns new retrieval instructions without extra tools", async () => {
  const f = await fixture(),
    focused = focusedInput(source.content, f.hash, f.plan);
  expect(buildDiscoveryRequest(focused, 4, f.scope)).toEqual(
    buildDiscoveryRequest(focused, 4, f.scope, 1),
  );
  const next = buildDiscoveryRequest(focused, 4, f.scope, 2);
  expect(next.max_tool_calls).toBe(1);
  expect(next.instructions).toContain("minecraft-bedrock-stable");
  const d = await parseDiscovery(
    f.result,
    source.content,
    f.plan,
    JSON.stringify(f.result),
    4,
    f.scope,
    2,
  );
  const req = buildRetrievalRequest(focused, d, "high");
  expect(req.instructions).not.toContain("query/fragment/認証つきURLは禁止");
  expect(req.instructions).toContain("固定文書view");
  expect(JSON.parse(req.input).discovery.selectedUrl).toBe(url);
});
it("requires the same opened and cited URL and support; binds evidence policy to saved job on load", async () => {
  const f = await fixture(),
    d = await parseDiscovery(
      f.result,
      source.content,
      f.plan,
      JSON.stringify(f.result),
      4,
      f.scope,
      2,
    );
  const prose = "Synthetic supported passage [1].";
  const result: any = {
    id: "resp_retrieval",
    status: "completed",
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "open_page", url },
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text:
              prose +
              "\n```json\n" +
              JSON.stringify({
                verdict: "verified",
                sources: [
                  {
                    url,
                    title: "Synthetic fixture",
                    claimId: f.plan.claimId,
                    excerpt:
                      "Synthetic support text for validator testing only.",
                    assessment: "supports",
                  },
                ],
              }) +
              "\n```",
            annotations: [
              { type: "url_citation", url, start_index: 28, end_index: 31 },
            ],
          },
        ],
      },
    ],
  };
  const evidence = parseResearch(
    result,
    source.content,
    f.hash,
    Date.now(),
    f.plan,
    d,
  );
  expect(evidenceReferences(evidence)).toEqual([url]);
  const changed = structuredClone(result);
  changed.output[0].action.url = url.split("?")[0];
  expect(() =>
    parseResearch(changed, source.content, f.hash, Date.now(), f.plan, d),
  ).toThrow();
  const noCitation = structuredClone(result);
  noCitation.output[1].content[0].annotations = [];
  expect(() =>
    parseResearch(noCitation, source.content, f.hash, Date.now(), f.plan, d),
  ).toThrow();
  const old = structuredClone(d);
  delete old.referencePolicy;
  expect(() =>
    parseResearch(result, source.content, f.hash, Date.now(), f.plan, old),
  ).toThrow();
  const row = { result_sha256: await sha256(JSON.stringify(evidence)) };
  const env: any = {
    CMS_AI_DB: {
      prepare: (q: string) => ({
        bind: () => ({
          first: async () =>
            q.includes("seo_review_continuations") ||
            q.includes("seo_review_continuation_retries") ||
            q.includes("seo_review_scope_reassessments")
              ? null
              : row,
        }),
      }),
    },
    CMS_AI_IMAGES: { get: async () => ({ json: async () => evidence }) },
  };
  await expect(
    loadResearch(env, { sourceSha256: f.hash, referencePolicy: 2 } as any),
  ).resolves.toEqual(evidence);
  await expect(
    loadResearch(env, { sourceSha256: f.hash, referencePolicy: 1 } as any),
  ).rejects.toThrow("seo_check_evidence");
});
it("migration preserves every old column and makes policy immutable", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE seo_editorial_jobs(id TEXT PRIMARY KEY,status TEXT,nullable TEXT); INSERT INTO seo_editorial_jobs VALUES('old','unresolved',NULL)",
  );
  const before = db.prepare("SELECT * FROM seo_editorial_jobs").all();
  db.exec(
    readFileSync(
      new URL("../migrations/0020_seo_reference_policy.sql", import.meta.url),
      "utf8",
    ),
  );
  expect(
    db.prepare("SELECT id,status,nullable FROM seo_editorial_jobs").all(),
  ).toEqual(before);
  expect(
    db.prepare("SELECT reference_policy FROM seo_editorial_jobs").get()!
      .reference_policy,
  ).toBe(1);
  expect(() =>
    db.exec("UPDATE seo_editorial_jobs SET reference_policy=2"),
  ).toThrow("immutable_reference_policy");
  db.exec(
    "INSERT INTO seo_editorial_jobs(id,reference_policy) VALUES('new',2)",
  );
  expect(() =>
    db.exec("UPDATE seo_editorial_jobs SET reference_policy=1 WHERE id='new'"),
  ).toThrow();
  expect(() =>
    db.exec(
      "INSERT INTO seo_editorial_jobs(id,reference_policy) VALUES('bad',3)",
    ),
  ).toThrow();
  db.close();
});

it("does not call a fixed-view variant of an already cited document new", async () => {
  const f = await fixture(),
    raw = JSON.stringify(f.result);
  const withExisting =
    source.content + "\n\n[Existing](" + url.split("?")[0] + ")";
  await expect(
    parseDiscovery(
      f.result,
      withExisting,
      { ...f.plan, sourceSha256: await sha256(withExisting) },
      raw,
      4,
      f.scope,
      2,
    ),
  ).rejects.toThrow("seo_research_insufficient");
});

it("separates new prompt explanation from unchanged URL/evidence contracts", async () => {
  const f = await fixture(),
    focused = focusedInput(source.content, f.hash, f.plan);
  const d = await parseDiscovery(
    f.result,
    source.content,
    f.plan,
    JSON.stringify(f.result),
    4,
    f.scope,
    2,
  );
  const oldDiscovery = buildDiscoveryRequest(focused, 4, f.scope, 2);
  expect(buildDiscoveryRequest(focused, 4, f.scope, 2, 1)).toEqual(
    oldDiscovery,
  );
  const next = buildDiscoveryRequest(focused, 4, f.scope, 2, 2);
  expect(next.instructions).toContain(
    "NOT a Microsoft Learn-only host allowlist",
  );
  expect(next.instructions).toContain("restrictions apply ONLY");
  expect(next.input).toBe(oldDiscovery.input);
  expect(next.max_tool_calls).toBe(oldDiscovery.max_tool_calls);
  const oldRetrieve = buildRetrievalRequest(focused, d, "high");
  expect(buildRetrievalRequest(focused, d, "high", 1)).toEqual(oldRetrieve);
  const retrieve = buildRetrievalRequest(focused, d, "high", 2);
  expect(retrieve.instructions).toContain(
    "NOT a Microsoft Learn-only host allowlist",
  );
  expect(retrieve.input).toBe(oldRetrieve.input);
  expect(retrieve.tools).toEqual(oldRetrieve.tools);
  for (const bad of [0, 3]) {
    expect(() => buildDiscoveryRequest(focused, 4, f.scope, 2, bad)).toThrow(
      "seo_url_instructions",
    );
    expect(() => buildRetrievalRequest(focused, d, "high", bad)).toThrow(
      "seo_url_instructions",
    );
  }
  const help =
    "https://help.minecraft.net/hc/en-us/articles/4409236107789-Troubleshoot-Unable-to-Join-Multiplayer-Games-in-Minecraft";
  expect(referenceUrl(help, 2)).toBe(help);
  expect(referenceUrl(url, 2)).toBe(url);
  expect(() =>
    referenceUrl(help + "?view=minecraft-bedrock-stable", 2),
  ).toThrow();
  expect(() => referenceUrl(url + "&token=fixture", 2)).toThrow();
});
it("URL instruction migration preserves old values, defaults to old prompts and is immutable", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE seo_editorial_jobs(id TEXT PRIMARY KEY,reference_policy INTEGER,status TEXT); INSERT INTO seo_editorial_jobs VALUES('old',2,'unresolved')",
  );
  const old = db.prepare("SELECT * FROM seo_editorial_jobs").all();
  db.exec(
    readFileSync(
      new URL("../migrations/0021_seo_url_instructions.sql", import.meta.url),
      "utf8",
    ),
  );
  expect(
    db
      .prepare("SELECT id,reference_policy,status FROM seo_editorial_jobs")
      .all(),
  ).toEqual(old);
  expect(
    db.prepare("SELECT url_instructions FROM seo_editorial_jobs").get()!
      .url_instructions,
  ).toBe(1);
  expect(() =>
    db.exec("UPDATE seo_editorial_jobs SET url_instructions=2"),
  ).toThrow("immutable_url_instructions");
  db.exec("INSERT INTO seo_editorial_jobs VALUES('new',2,'pending',2)");
  expect(() =>
    db.exec("INSERT INTO seo_editorial_jobs VALUES('bad',2,'pending',3)"),
  ).toThrow();
  db.close();
});

it("preserves the real trial4 insufficient shape despite an eligible queryless result", async () => {
  const f = await fixture();
  const help =
    "https://help.minecraft.net/hc/en-us/articles/4409236107789-Troubleshoot-Unable-to-Join-Multiplayer-Games-in-Minecraft";
  f.result.output[0].action!.sources = [{ type: "url", url: help }];
  f.result.output[1].content![0].text = JSON.stringify({
    verdict: "insufficient",
    selectedUrl: null,
    reason:
      "検索結果には公式資料がありますが、既存URLと重複するか、許可されたlearn.microsoft.comのURL形式に該当しません。",
  });
  // Redacted real response shape, not a fabricated successful provider response.
  await expect(
    parseDiscovery(
      f.result,
      source.content,
      f.plan,
      JSON.stringify(f.result),
      4,
      f.scope,
      2,
    ),
  ).rejects.toThrow("seo_research_insufficient");
  expect(referenceUrl(help, 2)).toBe(help);
});
