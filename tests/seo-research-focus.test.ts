import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sha256 } from "../src/seo-hash.ts";
import { parsePlan, focusedInput } from "../src/seo-research-plan.ts";
import { parseDiscovery } from "../src/seo-discovery.ts";
import { externalScope } from "../src/seo-external-sources.ts";
import { buildRetrievalRequest, parseResearch } from "../src/seo-checks.ts";
import { reconsiderationProof } from "../src/seo-reconsideration.ts";
import type { AppEnv } from "../src/env.ts";
import * as miniflare from "miniflare";
const github = vi.hoisted(() => ({ workflow: vi.fn(), absent: vi.fn() }));
vi.mock("../src/github.ts", () => ({
  seoWorkflowCompleted: github.workflow,
  seoPublicationAbsent: github.absent,
}));
const job = "11111111-1111-4111-8111-111111111111",
  site = "acecore-systems",
  path = "src/content/insights/example.md",
  article = site + ":" + path,
  target =
    "ExampleEngine の glob ローダーが `**/*.md` パターンで再帰検出します。",
  source =
    "---\ntitle: Example\n---\n\n翻訳記事は言語コードのディレクトリに配置します。" +
    target +
    "\n",
  url = "https://docs.example.org/loader";
let db: DatabaseSync,
  env: AppEnv,
  objects: Map<string, string>,
  plan: any,
  discovery: any,
  hash: string,
  rejected: any;
const key = (suffix: string) => `seo-editorial/${job}/${suffix}.json`;
const message = (text: string) => ({
  type: "message",
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }],
});
const response = (output: any[]) => ({
  id: "resp_example",
  status: "completed",
  usage: { input_tokens: 100, output_tokens: 50 },
  output,
});
beforeEach(async () => {
  github.workflow.mockReset().mockResolvedValue(true);
  github.absent.mockReset().mockResolvedValue(true);
  hash = await sha256(source);
  objects = new Map();
  const value = {
    verdict: "ready",
    claimId: "claim-1",
    targetQuote: target,
    conditions: [target],
    anchors: ["ExampleEngine"],
    queries: ["ExampleEngine glob loader official docs"],
  };
  plan = parsePlan(value, source, hash, 2, 2);
  const search = response([
    {
      type: "web_search_call",
      status: "completed",
      action: {
        type: "search",
        queries: plan.queries,
        sources: [{ type: "url", url }],
      },
    },
    message(
      JSON.stringify({
        verdict: "selected",
        selectedUrl: url,
        fallbackUrl: null,
        reason: "Relevant primary documentation candidate",
      }),
    ),
  ]);
  discovery = await parseDiscovery(
    search,
    source,
    plan,
    JSON.stringify(search),
    5,
    externalScope(site, { path, content: source }),
    2,
  );
  rejected = response([
    {
      type: "web_search_call",
      status: "completed",
      action: { type: "open_page", url },
    },
    message(
      "Independent local context is unverified.\n```json\n" +
        JSON.stringify({
          verdict: "insufficient",
          sources: [],
          retrieval: [{ url, outcome: "retrieved" }],
        }) +
        "\n```",
    ),
  ]);
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE seo_editorial_jobs(id,run_id,site_id,github_run_id,base_sha,source_sha256,article_key,article_path,status,generation_started,publication_started,next_step,call_id,callback_recorded,claim_recorded,research_contract,retrieval_contract,research_recovery,reference_policy);
CREATE TABLE seo_editorial_runs(run_id,job_id,article_key,status,pr_url,deadline,budget_run_id);
CREATE TABLE seo_research_rejections(job_id,run_id,receipt_sha256,receipt_json);
CREATE TABLE seo_plan_contracts(job_id,version); CREATE TABLE seo_research_focus_contracts(job_id,version);
CREATE TABLE seo_source_recovery_contracts(job_id,version);
CREATE TABLE seo_all_checks(job_id,phase,call_id,input_sha256,status,result_sha256);
CREATE TABLE seo_budget_calls(id,run_id,status,request_sha256);
CREATE TABLE seo_model_calls(call_id,job_id,phase,request_sha256,budget_run_id);`);
  const insert = db.prepare(
    "INSERT INTO seo_editorial_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  insert.run(
    job,
    "old",
    site,
    "123",
    "b".repeat(40),
    hash,
    article,
    path,
    "unresolved",
    0,
    0,
    0,
    null,
    1,
    1,
    2,
    2,
    2,
    2,
  );
  insert.run(
    "new-job",
    "new",
    site,
    "456",
    "b".repeat(40),
    hash,
    article,
    path,
    "claiming",
    0,
    0,
    0,
    null,
    0,
    0,
    2,
    2,
    2,
    2,
  );
  db.prepare("INSERT INTO seo_editorial_runs VALUES(?,?,?,?,?,?,?)").run(
    "old",
    job,
    article,
    "unresolved",
    null,
    1000,
    "budget-old",
  );
  db.prepare("INSERT INTO seo_editorial_runs VALUES(?,?,?,?,?,?,?)").run(
    "new",
    "new-job",
    null,
    "pending",
    null,
    Date.now() + 60000,
    "budget-new",
  );
  db.prepare("INSERT INTO seo_plan_contracts VALUES(?,2)").run(job);
  db.exec(
    "INSERT INTO seo_plan_contracts VALUES('new-job',2); INSERT INTO seo_research_focus_contracts VALUES('new-job',2)",
  );
  objects.set(key("source"), JSON.stringify([{ path, content: source }]));
  objects.set(key("plan"), JSON.stringify(plan));
  objects.set(key("discovery"), JSON.stringify(discovery));
  const phases = ["plan", "discovery", "research"],
    results = [response([message(JSON.stringify(value))]), search, rejected],
    calls = [];
  for (const [i, phase] of phases.entries()) {
    const callId = "seo-call-" + i,
      raw = JSON.stringify(results[i]),
      manifest = JSON.stringify({
        callId,
        inputSha256: "input-" + i,
        responseKey: `seo-responses/${callId}.json`,
      });
    objects.set(`seo-responses/${callId}.json`, raw);
    objects.set(key(phase + "-call"), manifest);
    db.prepare("INSERT INTO seo_all_checks VALUES(?,?,?,?,?,?)").run(
      job,
      phase,
      callId,
      "input-" + i,
      i === 2 ? "unresolved" : "complete",
      i === 2 ? null : await sha256(objects.get(key(phase))!),
    );
    db.prepare("INSERT INTO seo_budget_calls VALUES(?,?,?,?)").run(
      callId,
      "budget-old",
      "complete",
      "request-" + i,
    );
    db.prepare("INSERT INTO seo_model_calls VALUES(?,?,?,?,?)").run(
      callId,
      job,
      phase,
      "request-" + i,
      "budget-old",
    );
    calls.push({
      phase,
      callId,
      responseSha256: await sha256(raw),
      manifestSha256: await sha256(manifest),
      status: "completed",
      verdict: i === 2 ? "insufficient" : "ready",
    });
  }
  objects.set(
    key("research-failure"),
    JSON.stringify({
      callId: "seo-call-2",
      code: "seo_research_insufficient",
      responseStored: true,
    }),
  );
  const receipt = JSON.stringify({
    version: 2,
    runId: "old",
    jobId: job,
    articleKey: article,
    sourceSha256: hash,
    deadline: 1000,
    calls,
    reason: "confirmed_insufficient",
    researchContract: 2,
    generationCalls: 0,
    generationArtifacts: 0,
    publicationStarted: false,
    baseSha: "b".repeat(40),
    githubRunId: "123",
    refs: [],
    pullRequests: [],
    decisionTime: 999,
  });
  objects.set(key("rejection"), receipt);
  db.prepare("INSERT INTO seo_research_rejections VALUES(?,?,?,?)").run(
    job,
    "old",
    await sha256(receipt),
    receipt,
  );
  const prepare = (q: string) => {
    const bound = (args: any[] = []): any => ({
      bind: (...v: any[]) => bound(v),
      first: async () => db.prepare(q).get(...args) ?? null,
      all: async () => ({ results: db.prepare(q).all(...args) }),
    });
    return bound();
  };
  env = {
    SEO_RESEARCH_ENABLED: "true",
    SEO_EDITORIAL_ENABLED: "true",
    CMS_AI_DB: { prepare },
    CMS_AI_IMAGES: {
      get: async (k: string) =>
        objects.has(k) ? { text: async () => objects.get(k) } : null,
    },
  } as unknown as AppEnv;
});
afterEach(() => db.close());
const input = { runId: "old", articleKey: article };
it("retains the exact proof under delayed R2 reads with bounded concurrency and one fetch per object", async () => {
  const original = env.CMS_AI_IMAGES.get.bind(env.CMS_AI_IMAGES),
    calls = new Map<string, number>(),
    bodies = new Map<string, number>();
  let active = 0,
    peak = 0;
  env.CMS_AI_IMAGES.get = (async (key: string) => {
    calls.set(key, (calls.get(key) ?? 0) + 1);
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    const object = await original(key);
    active--;
    return object
      ? {
          text: async () => {
            bodies.set(key, (bodies.get(key) ?? 0) + 1);
            await new Promise((r) => setTimeout(r, 5));
            return object.text();
          },
        }
      : null;
  }) as typeof env.CMS_AI_IMAGES.get;
  const proof = await reconsiderationProof(env, {
    ...input,
    deadline: Date.now() + 10000,
  });
  expect(proof).toMatchObject({ status: "eligible", version: 2 });
  expect(Object.keys(proof)).toHaveLength(8);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(4);
  expect([...calls.values()].every((n) => n === 1)).toBe(true);
  expect([...bodies.values()].every((n) => n === 1)).toBe(true);
  expect(calls.size).toBe(19);
  // A later proof must re-read; a changed object cannot inherit the earlier cache.
  objects.set(key("plan"), "{}");
  expect(await reconsiderationProof(env, input)).toEqual({ status: "denied" });
  expect(calls.get(key("plan"))).toBe(2);
});
it("returns exact focus2 proof shape after unchanged SQL, R2 and completed-call validation without writes", async () => {
  const before = db.prepare("SELECT * FROM seo_editorial_jobs").all(),
    stored = [...objects];
  const proof = await reconsiderationProof(env, input);
  expect(proof).toEqual({
    status: "eligible",
    version: 2,
    runId: "old",
    articleKey: article,
    sourceSha256: hash,
    receiptSha256: await sha256(objects.get(key("rejection"))!),
    fromResearchFocus: 1,
    toResearchFocus: 2,
  });
  expect(
    await reconsiderationProof(env, { ...input, newRunId: "new" }),
  ).toEqual({ ...proof, newRunId: "new" });
  expect(db.prepare("SELECT * FROM seo_editorial_jobs").all()).toEqual(before);
  expect([...objects]).toEqual(stored);
  expect(github.absent).toHaveBeenCalled();
});
it("executes the complete proof SQL against workerd D1 without writes", async () => {
  const options = {
    modules: true,
    script: "export default {fetch(){return new Response(null)}}",
    compatibilityDate: "2026-09-01",
    d1Databases: ["DB"],
  };
  const convert = (miniflare as any).convertV4MiniflareOptions;
  const mf = new miniflare.Miniflare(convert ? convert(options) : options);
  try {
    const d1 = await mf.getD1Database("DB"),
      tables = db
        .prepare("SELECT name,sql FROM sqlite_master WHERE type='table'")
        .all() as any[];
    for (const table of tables) {
      await d1.exec(table.sql);
      for (const row of db.prepare("SELECT * FROM " + table.name).all()) {
        const values = Object.values(row);
        await d1
          .prepare(
            `INSERT INTO ${table.name} VALUES(${values.map(() => "?").join(",")})`,
          )
          .bind(...values)
          .run();
      }
    }
    const local = { ...env, CMS_AI_DB: d1 } as AppEnv;
    expect(
      await reconsiderationProof(local, { ...input, newRunId: "new" }),
    ).toMatchObject({ status: "eligible", version: 2 });
    await d1
      .prepare(
        "UPDATE seo_budget_calls SET status='unresolved' WHERE id='seo-call-2'",
      )
      .run();
    expect(await reconsiderationProof(local, input)).toEqual({
      status: "denied",
    });
    expect(
      (
        await d1
          .prepare("SELECT status FROM seo_editorial_jobs WHERE run_id='old'")
          .first()
      )?.status,
    ).toBe("unresolved");
  } finally {
    await mf.dispose();
  }
}, 30000);
it.each([
  "UPDATE seo_budget_calls SET status='unresolved' WHERE id='seo-call-2'",
  "UPDATE seo_model_calls SET request_sha256='changed' WHERE phase='research'",
  "INSERT INTO seo_budget_calls VALUES('extra','budget-old','complete','extra')",
  "INSERT INTO seo_model_calls VALUES('extra','" +
    job +
    "','generation','extra','budget-old')",
  "UPDATE seo_all_checks SET input_sha256='changed' WHERE phase='research'",
  "UPDATE seo_all_checks SET result_sha256='changed' WHERE phase='plan'",
  "INSERT INTO seo_research_focus_contracts VALUES('" + job + "',2)",
  "UPDATE seo_editorial_jobs SET generation_started=1 WHERE run_id='old'",
  "DELETE FROM seo_research_focus_contracts WHERE job_id='new-job'",
  "UPDATE seo_editorial_jobs SET source_sha256='changed' WHERE run_id='new'",
])(
  "denies changed contract, unknown charge, extra generation or mismatched evidence: %s",
  async (q) => {
    db.exec(q);
    expect(
      await reconsiderationProof(env, { ...input, newRunId: "new" }),
    ).toEqual({ status: "denied" });
  },
);
it.each([
  "source",
  "plan",
  "discovery",
  "plan-call",
  "research-call",
  "research-failure",
  "rejection",
])("denies missing %s evidence", async (suffix) => {
  objects.delete(key(suffix));
  expect(await reconsiderationProof(env, input)).toEqual({ status: "denied" });
});
it("denies altered complete target, partial conditions, changed response or publication artifacts", async () => {
  for (const edit of [
    (p: any) => (p.target.quote = target.slice(2)),
    (p: any) => (p.requiredConditions[0].quote = target.slice(2)),
    (p: any) => (p.claimMarkdown = target),
  ]) {
    const p = structuredClone(plan);
    edit(p);
    objects.set(key("plan"), JSON.stringify(p));
    expect(await reconsiderationProof(env, input)).toEqual({
      status: "denied",
    });
  }
  objects.set(key("plan"), JSON.stringify(plan));
  objects.set(key("review-call"), "{}");
  expect(await reconsiderationProof(env, input)).toEqual({ status: "denied" });
  objects.delete(key("review-call"));
  objects.set(
    "seo-responses/seo-call-2.json",
    JSON.stringify({
      ...rejected,
      usage: { input_tokens: 101, output_tokens: 50 },
    }),
  );
  expect(await reconsiderationProof(env, input)).toEqual({ status: "denied" });
});
it("denies unknown workflow or any GitHub publication state", async () => {
  github.absent.mockResolvedValue(false);
  expect(await reconsiderationProof(env, input)).toEqual({ status: "denied" });
  github.absent.mockResolvedValue(true);
  github.workflow.mockResolvedValue(false);
  expect(await reconsiderationProof(env, input)).toEqual({ status: "denied" });
});
it("versions prompt only, retains exact whole target/conditions/context and never upgrades saved insufficient", () => {
  const focused = focusedInput(source, hash, plan),
    legacy = buildRetrievalRequest(focused, discovery, "high", 2),
    next = buildRetrievalRequest(focused, discovery, "high", 2, 2);
  expect(legacy).toEqual(
    buildRetrievalRequest(focused, discovery, "high", 2, 1),
  );
  expect(next.input).toEqual(legacy.input);
  expect(next.max_tool_calls).toBe(2);
  expect(next.tools).toEqual(legacy.tools);
  expect(next.instructions).toContain("ALL requiredConditions");
  expect(next.instructions).toContain(
    "Unknown support of the fixed target remains insufficient",
  );
  expect(legacy.instructions).not.toContain(
    "independent statement in claimMarkdown",
  );
  expect(() =>
    parseResearch(rejected, source, hash, Date.now(), plan, discovery),
  ).toThrow("seo_research_insufficient");
});
it("migration registers new jobs only and preserves legacy rows", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE seo_editorial_jobs(id TEXT PRIMARY KEY,run_id TEXT); INSERT INTO seo_editorial_jobs VALUES('old','run-old')",
    );
    sql.exec(
      readFileSync(
        new URL("../migrations/0041_seo_research_focus.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(
      sql.prepare("SELECT * FROM seo_research_focus_contracts").all(),
    ).toEqual([]);
    expect(() =>
      sql.exec("INSERT INTO seo_research_focus_contracts VALUES('old',2)"),
    ).toThrow("new_only");
    sql.exec(
      "BEGIN; INSERT INTO seo_research_focus_contracts VALUES('new',2); INSERT INTO seo_editorial_jobs VALUES('new','run-new'); COMMIT",
    );
    for (const q of [
      "UPDATE seo_research_focus_contracts SET version=2",
      "DELETE FROM seo_research_focus_contracts",
      "UPDATE seo_editorial_jobs SET run_id='other' WHERE id='new'",
      "DELETE FROM seo_editorial_jobs WHERE id='new'",
      "INSERT OR REPLACE INTO seo_research_focus_contracts VALUES('new',2)",
    ])
      expect(() => sql.exec(q)).toThrow();
  } finally {
    sql.close();
  }
});
