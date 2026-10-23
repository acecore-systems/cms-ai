import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { it, expect } from "vitest";
import { buildPlanRequest } from "../src/seo-checks.ts";
import {
  FACT_PLAN_SCHEMA,
  parsePlan,
  plannerClaims,
  focusedInput,
} from "../src/seo-research-plan.ts";
import { tableClaims } from "../src/seo-table-claims.ts";
import { deepseekPayload, assertStrictSchema } from "../src/seo-deepseek.ts";
import {
  currentInputPreflightOptions,
  planInputBytes,
} from "../src/seo-input-preflight.ts";
import { externalScope } from "../src/seo-external-sources.ts";
import { assertStageInput } from "../src/seo-stage-budget.ts";
import { buildDiscoveryRequest } from "../src/seo-discovery.ts";

// Synthetic source, not a copy of a private canary or retrieved evidence.
const source = {
  path: "poc/astro-sveltia/src/content/wiki/plugins.md",
  content:
    "---\ntitle: 機能一覧\n---\n旧記録であり、現在の導入状況は未確認です。\n\n| プラグイン名 | 機能 |\n| --- | --- |\n| [CoreProtect](https://example.org/product) | ブロックの設置や破壊などのログを記録します。 |\n",
};
const scope = externalScope("aceserver-wiki", source);
const request = (v = 1) => buildPlanRequest(source.content, 2, 5, scope, 2, v);
const bytes = (v: unknown) =>
  new TextEncoder().encode(JSON.stringify(v)).length;

it("new planner states both outcomes and preserves exact table functionality without requiring prior evidence", () => {
  const old = request(),
    next = request(2),
    payload = deepseekPayload(next, true);
  expect(old).toEqual(buildPlanRequest(source.content, 2, 5, scope, 2));
  expect(old.instructions).not.toContain('verdict="ready"');
  expect(next.instructions).toContain('verdict="ready"');
  expect(next.instructions).toContain('verdict="insufficient"');
  expect(next.instructions).toContain("本文が未取得");
  expect(next.instructions).toContain("conditionsは[featureMarkdown全文]");
  expect(next.instructions).toContain(
    "schemaはresponse_formatにも同一内容を渡す: " +
      JSON.stringify(FACT_PLAN_SCHEMA),
  );
  expect((payload.response_format as any).json_schema.schema).toEqual(
    FACT_PLAN_SCHEMA,
  );
  // runTextModel reconstructs this Chat payload once; preserve schema and messages exactly.
  expect(deepseekPayload(payload)).toEqual(payload);
  expect(JSON.parse(next.input as string).claims).toEqual(
    plannerClaims(source.content, 2, 2),
  );
  const c = tableClaims(source.content)[0];
  const answer = {
    verdict: "ready",
    claimId: c.id,
    targetQuote: c.markdown,
    conditions: [c.tableContext.featureMarkdown],
    anchors: ["CoreProtect"],
    queries: ["CoreProtect official block logging"],
  };
  expect(() => assertStrictSchema(answer, FACT_PLAN_SCHEMA)).not.toThrow();
  const plan = parsePlan(answer, source.content, "a".repeat(64), 2, 2);
  expect(plan.tableContext!.precedingMarkdown).toContain(
    "現在の導入状況は未確認",
  );
  const search = buildDiscoveryRequest(
    focusedInput(source.content, "a".repeat(64), plan),
    5,
    scope,
    2,
    2,
    2,
  );
  expect(search.instructions).toContain(
    "does NOT decide whether the factual claim is supported",
  );
  expect(search.instructions).toContain("Do not return insufficient SOLELY");
  expect(search.max_tool_calls).toBe(1);
  for (const invalid of [
    { ...answer, targetQuote: c.tableContext.featureMarkdown },
    { ...answer, conditions: ["設置や破壊"] },
    { ...answer, queries: ["CoreProtect https://docs.example.org"] },
    { ...answer, anchors: ["OtherPlugin"] },
  ])
    expect(() =>
      parsePlan(invalid, source.content, "a".repeat(64), 2, 2),
    ).toThrow();
  expect(() =>
    parsePlan(
      {
        ...answer,
        verdict: "insufficient",
        claimId: "",
        targetQuote: "",
        conditions: [],
        anchors: [],
        queries: [],
      },
      source.content,
      "a".repeat(64),
      2,
      2,
    ),
  ).toThrow("seo_research_insufficient");
});
it("preflight measures the actual new Chat request and leaves explicit old-job bytes unchanged", () => {
  const options = {
    ...currentInputPreflightOptions("aceserver-wiki"),
    model_version: 2 as const,
  };
  expect(options.plan_instructions).toBe(2);
  expect(planInputBytes(source, options)).toBe(
    bytes(deepseekPayload(request(2), true)),
  );
  const old = { ...options, plan_instructions: 1 as const };
  expect(planInputBytes(source, old)).toBe(
    bytes(deepseekPayload(request(), true)),
  );
  expect(planInputBytes(source, { ...old, plan_instructions: undefined })).toBe(
    planInputBytes(source, old),
  );
  expect(() =>
    assertStageInput("plan", deepseekPayload(request(2), true), 2, 2, 2),
  ).not.toThrow();
  expect(() => buildPlanRequest(source.content, 1, 2, undefined, 1, 2)).toThrow(
    "seo_plan_instructions",
  );
});
it("0033 leaves every old table row and schema definition untouched and cannot retrofit old jobs", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const file of readdirSync(new URL("../migrations/", import.meta.url))
      .filter((n) => n.endsWith(".sql") && n >= "0004" && n < "0033")
      .sort())
      db.exec(
        readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"),
      );
    db.exec(
      "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at) VALUES('old','budget','hash',99,'[]',1); INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index) VALUES('old-job','old','wiki',0)",
    );
    const schema = db
      .prepare(
        "SELECT * FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((x) => String(x.name));
    const rows = () =>
      tables.map((t) => db.prepare("SELECT * FROM " + t).all());
    const before = rows();
    db.exec(
      readFileSync(
        new URL("../migrations/0033_seo_plan_contracts.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(rows()).toEqual(before);
    for (const item of schema)
      expect(
        db.prepare("SELECT * FROM sqlite_master WHERE name=?").get(item.name!),
      ).toEqual(item);
    expect(
      db
        .prepare(
          "SELECT COALESCE(p.version,1) version FROM seo_editorial_jobs j LEFT JOIN seo_plan_contracts p ON p.job_id=j.id WHERE j.id=?",
        )
        .get("old-job")!.version,
    ).toBe(1);
    expect(() =>
      db.exec("INSERT INTO seo_plan_contracts VALUES('old-job',2)"),
    ).toThrow("seo_plan_new_only");
    expect(() =>
      db.exec("INSERT INTO seo_plan_contracts VALUES('orphan',2)"),
    ).toThrow();
    expect(
      db.prepare("SELECT count(*) n FROM seo_plan_contracts").get()!.n,
    ).toBe(0);
    db.exec(
      "BEGIN; INSERT INTO seo_plan_contracts VALUES('new-job',2); INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index) VALUES('new-job','old','wiki',1); COMMIT",
    );
    for (const sql of [
      "DELETE FROM seo_plan_contracts",
      "UPDATE seo_plan_contracts SET version=2",
      "INSERT OR REPLACE INTO seo_plan_contracts VALUES('new-job',2)",
      "UPDATE seo_editorial_jobs SET id='replaced' WHERE id='new-job'",
      "DELETE FROM seo_editorial_jobs WHERE id='new-job'",
    ])
      expect(() => db.exec(sql)).toThrow();
  } finally {
    db.close();
  }
});
