import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  stageBudget,
  assertStageInput,
  allocateGenerationInputs,
} from "../src/seo-stage-budget.ts";
import { responseRequest, responsesUpperCost } from "../src/seo-responses.ts";
import { upperCost } from "../src/seo-budget.ts";
import { buildReviewRequest } from "../src/seo-checks.ts";
import { sourceIdentity } from "../src/seo-content.ts";
const now = Date.parse("2026-10-23T00:00:00Z");
const fill = (request: any, bytes: number) => {
  request.padding = "";
  request.padding = "x".repeat(
    bytes - Buffer.byteLength(JSON.stringify(request)),
  );
  return request;
};
it("funds 24000 review output using 60000 fewer input bytes, with all 13 real builder costs", () => {
  const budget = stageBudget(2, 2, 2);
  const plan = fill(responseRequest("", {}, {}), 32000);
  const discovery = fill(
    { ...responseRequest("", {}, null, true), max_tool_calls: 1 },
    8000,
  );
  const retrieval = { ...discovery, max_tool_calls: 2 };
  // Digit width is identical; all requests remain at their exact cap.
  const review = fill(
    { ...responseRequest("", {}, {}), max_output_tokens: 24000 },
    440000,
  );
  const generation = allocateGenerationInputs(
    Array.from({ length: 9 }, (_, i) => ({ path: `p${i}`, bytes: 40000 })),
    2,
    2,
  );
  const costs = [
    responsesUpperCost(plan, now, 2),
    responsesUpperCost(discovery, now, 2),
    responsesUpperCost(retrieval, now, 2),
    ...generation.map((x) =>
      upperCost(
        "gpt-6-luna",
        fill(
          {
            service_tier: "default",
            max_completion_tokens: 12000,
            messages: [],
          },
          x.maxBytes,
        ),
        now,
      ),
    ),
    responsesUpperCost(review, now, 2, 2),
  ];
  expect(costs).toHaveLength(13);
  expect(costs.reduce((a, b) => a + b, 0)).toBe(1249533);
  expect(budget.maximum).toBe(1249533);
  expect(budget.maximum).toBe(stageBudget(2, 2).maximum);
  expect(budget.pool).toBe(525000);
  expect(() => assertStageInput("review", review, 2, 2, 2)).not.toThrow();
  expect(() =>
    assertStageInput(
      "review",
      { ...review, padding: review.padding + "x" },
      2,
      2,
      2,
    ),
  ).toThrow();
  expect(() => responsesUpperCost(review, now, 2)).toThrow();
  expect(() =>
    responsesUpperCost({ ...discovery, max_output_tokens: 24000 }, now, 2, 2),
  ).toThrow();
  expect(() =>
    responsesUpperCost({ ...review, reasoning: { effort: "low" } }, now, 2, 2),
  ).toThrow();
  expect(() => stageBudget(1, 1, 2)).toThrow();
  expect(() => stageBudget(2, 2, 3)).toThrow();
});
it("changes only review max_output_tokens, retaining high effort and all exact input", () => {
  const files = [
    {
      path: "src/content/blog/example.md",
      content:
        "---\ntitle: Original\ndate: 2026-08-08T00:00:00Z\n---\nAn original fact.\n",
    },
  ];
  const identity = sourceIdentity(
    "cherry",
    "https://cherry.acecore.net/blog/example/",
    files,
  )!;
  const evidence = {
    version: 1 as const,
    checkedAt: "",
    sourceSha256: "a".repeat(64),
    responseId: "fixture",
    queries: [],
    sources: [],
  };
  const old = buildReviewRequest(identity, files, files, evidence),
    current = buildReviewRequest(identity, files, files, evidence, 2);
  expect(buildReviewRequest(identity, files, files, evidence, 1)).toEqual(old);
  expect(current).toEqual({ ...old, max_output_tokens: 24000 });
  expect(current.reasoning).toEqual({ effort: "high" });
});
it("0025 preserves all prior rows and triggers; only new jobs opt into immutable version 2", () => {
  const db = new DatabaseSync(":memory:"),
    root = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(root)
    .filter((n) => /^\d+_seo/.test(n) && n < "0025")
    .sort())
    db.exec(readFileSync(new URL(name, root), "utf8"));
  db.exec(
    "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at) VALUES('old','budget','hash',1,'[]',0);INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index) VALUES('oldjob','old','site',0)",
  );
  const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name as string),
    rows = Object.fromEntries(
      tables.map((t) => [t, db.prepare(`SELECT * FROM ${t}`).all()]),
    ),
    triggers = db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
      )
      .all();
  db.exec(readFileSync(new URL("0025_seo_review_output.sql", root), "utf8"));
  for (const t of tables)
    expect(db.prepare(`SELECT * FROM ${t}`).all()).toEqual(
      t === "seo_editorial_jobs"
        ? rows[t].map((r) => ({ ...r, review_output: 1 }))
        : rows[t],
    );
  expect(
    db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name!='seo_review_output_immutable' ORDER BY name",
      )
      .all(),
  ).toEqual(triggers);
  expect(() =>
    db.exec("UPDATE seo_editorial_jobs SET review_output=2"),
  ).toThrow("immutable_review_output");
  db.close();
});
