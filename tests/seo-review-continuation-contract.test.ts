import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { it, expect } from "vitest";
import { continuationInput } from "../src/seo-review-continuation.ts";

const migrations = () =>
  readdirSync(new URL("../migrations/", import.meta.url))
    .filter((n) => n.endsWith(".sql") && n >= "0004")
    .sort();
const sql = (name: string) =>
  readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8");
const old =
  "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at,status,job_id,article_key) VALUES('old','budget','hash',1,'[]',0,'unresolved','old-job','article'); INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index,status,article_key,generation_started,publication_started,next_step) VALUES('old-job','old','site',0,'unresolved','article',1,0,1)";
const freshRun =
  "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at,job_id,article_key) VALUES('new','new-budget','hash',100,'[]',2,'new-job','article')";
const audit =
  "INSERT INTO seo_review_continuations VALUES('new-job','new','old-job','old','article','" +
  "a".repeat(64) +
  "','{}','" +
  "b".repeat(64) +
  "',1,'low',2)";
const freshJob =
  "INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index,article_key,next_step) VALUES('new-job','new','site',0,'article',1)";
it("0043 preserves old rows/schema and makes ownership, deadline and imported work immutable", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of migrations().filter((n) => n < "0043"))
      db.exec(sql(name));
    db.exec(old);
    const schema = db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    const rows = () =>
      tables.map((t) => db.prepare("SELECT * FROM " + t.name).all());
    const before = rows();
    db.exec(sql("0043_seo_review_continuation.sql"));
    expect(rows()).toEqual(before);
    for (const item of schema)
      expect(
        db
          .prepare("SELECT name,sql FROM sqlite_master WHERE name=?")
          .get(item.name!),
      ).toEqual(item);
    expect(() =>
      db.exec("INSERT INTO seo_review_effort_contracts VALUES('old-job',2)"),
    ).toThrow();
    db.exec(
      "BEGIN;" +
        freshRun +
        ";" +
        audit +
        "; INSERT INTO seo_review_effort_contracts VALUES('new-job',2);" +
        freshJob +
        ";COMMIT",
    );
    for (const query of [
      "DELETE FROM seo_review_continuations",
      "UPDATE seo_review_continuations SET version=1",
      audit.replace("INSERT INTO", "INSERT OR REPLACE INTO"),
      "UPDATE seo_editorial_jobs SET generation_started=1 WHERE id='new-job'",
      "UPDATE seo_editorial_jobs SET source_sha256='changed' WHERE id='new-job'",
      "UPDATE seo_editorial_runs SET deadline=200 WHERE run_id='new'",
      "DELETE FROM seo_editorial_runs WHERE run_id='new'",
      "DELETE FROM seo_review_effort_contracts",
      "UPDATE seo_review_effort_contracts SET version=2",
    ])
      expect(() => db.exec(query)).toThrow();
    expect(
      db
        .prepare(
          "SELECT generation_started,next_step FROM seo_editorial_jobs WHERE id='new-job'",
        )
        .get(),
    ).toEqual({ generation_started: 0, next_step: 1 });
  } finally {
    db.close();
  }
});
it("0043 audit and deferred job registration work in real workerd D1", async () => {
  const m = await import("miniflare");
  const options = {
    modules: true,
    script: "export default {fetch(){return new Response(null)}}",
    compatibilityDate: "2026-09-01",
    d1Databases: ["DB"],
  };
  const mf = new m.Miniflare(
    (m as any).convertV4MiniflareOptions
      ? (m as any).convertV4MiniflareOptions(options)
      : options,
  );
  try {
    const db = await mf.getD1Database("DB");
    for (const name of migrations())
      await db.exec(
        sql(name)
          .replace(/--[^\n]*/g, "")
          .replace(/\s+/g, " "),
      );
    await db.exec(old);
    await expect(
      db.batch([db.prepare(freshRun), db.prepare(audit)]),
    ).rejects.toThrow();
    expect(
      (await db
        .prepare("SELECT count(*) n FROM seo_review_continuations")
        .first())!.n,
    ).toBe(0);
    await db.batch([
      db.prepare(freshRun),
      db.prepare(audit),
      db.prepare("INSERT INTO seo_review_effort_contracts VALUES('new-job',2)"),
      db.prepare(freshJob),
    ]);
    await expect(
      db
        .prepare(
          "UPDATE seo_editorial_jobs SET generation_started=1 WHERE id='new-job'",
        )
        .run(),
    ).rejects.toThrow();
    expect(
      (await db.prepare("SELECT count(*) n FROM seo_budget_calls").first())!.n,
    ).toBe(0);
  } finally {
    await mf.dispose();
  }
});
it("requires exact proof input and an independent bounded deadline", () => {
  const valid = {
    oldRunId: "editorial-00000000-0000-4000-8000-000000000001",
    newRunId: "editorial-00000000-0000-4000-8000-000000000002",
    deadline: Date.now() + 600000,
  };
  expect(continuationInput(valid)).toEqual(valid);
  for (const bad of [
    { ...valid, extra: true },
    { ...valid, newRunId: valid.oldRunId },
    { ...valid, deadline: Date.now() - 1 },
    { ...valid, deadline: Date.now() + 1800001 },
  ])
    expect(() => continuationInput(bad)).toThrow();
});
