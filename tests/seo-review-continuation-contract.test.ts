import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { it, expect, vi } from "vitest";
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
  const now = Date.parse("2026-10-25T07:00:00Z");
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const valid = {
      oldRunId: "editorial-00000000-0000-4000-8000-000000000001",
      newRunId: "editorial-00000000-0000-4000-8000-000000000002",
      deadline: now + 600000,
    };
    expect(continuationInput(valid)).toEqual(valid);
    // Strict lower bound; inclusive upper bound. Both use the same clock.
    for (const offset of [1, 1799999, 1800000]) {
      const accepted = { ...valid, deadline: now + offset };
      expect(continuationInput(accepted)).toEqual(accepted);
    }
    for (const bad of [
      { ...valid, extra: true },
      { ...valid, newRunId: valid.oldRunId },
      ...[-1, 0, 1800001].map((offset) => ({
        ...valid,
        deadline: now + offset,
      })),
    ])
      expect(() => continuationInput(bad)).toThrow();
  } finally {
    clock.mockRestore();
  }
});

const retryRun =
  "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at,job_id,article_key) VALUES('retry','retry-budget','hash',300,'[]',200,'retry-job','article')";
const retryAudit =
  "INSERT INTO seo_review_continuation_retries(job_id,run_id,old_job_id,old_run_id,previous_job_id,previous_run_id,article_key,manifest_sha256,manifest_key,files_sha256,retry_sha256,retry_key,version,reasoning_effort,created_at) VALUES('retry-job','retry','old-job','old','new-job','new','article','" +
  "a".repeat(64) +
  "','root','" +
  "b".repeat(64) +
  "','" +
  "c".repeat(64) +
  "','retry-audit',2,'low',200)";
const retryJob =
  "INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index,article_key,next_step) VALUES('retry-job','retry','site',0,'article',1)";
const previousSetup =
  old +
  ";BEGIN;" +
  freshRun +
  ";" +
  audit +
  ";INSERT INTO seo_review_effort_contracts VALUES('new-job',2);" +
  freshJob +
  ";COMMIT; UPDATE seo_editorial_jobs SET status='unresolved',github_run_id='123',callback_recorded=1 WHERE id='new-job';UPDATE seo_editorial_runs SET status='unresolved' WHERE run_id='new'";
it("0044 changes no old schema/data and rejects old-zero writes, third jobs and extra phases", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of migrations().filter((n) => n < "0044"))
      db.exec(sql(name));
    db.exec(previousSetup);
    const schema = db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    const rows = () =>
      tables.map((t) => db.prepare("SELECT * FROM " + t.name).all());
    const before = rows();
    db.exec(sql("0044_seo_review_continuation_retry.sql"));
    expect(rows()).toEqual(before);
    for (const item of schema)
      expect(
        db
          .prepare("SELECT name,sql FROM sqlite_master WHERE name=?")
          .get(item.name!),
      ).toEqual(item);
    db.exec(
      "BEGIN;" +
        retryRun +
        ";" +
        retryAudit +
        ";INSERT INTO seo_review_effort_contracts VALUES('retry-job',2);" +
        retryJob +
        ";COMMIT",
    );
    for (const query of [
      "UPDATE seo_editorial_jobs SET github_run_id='124' WHERE id='new-job'",
      "DELETE FROM seo_editorial_jobs WHERE id='new-job'",
      "UPDATE seo_editorial_runs SET status='pending' WHERE run_id='new'",
      "DELETE FROM seo_editorial_runs WHERE run_id='new'",
      "UPDATE seo_editorial_runs SET deadline=301 WHERE run_id='retry'",
      "UPDATE seo_editorial_jobs SET generation_started=1 WHERE id='retry-job'",
      "UPDATE seo_editorial_jobs SET next_step=2 WHERE id='retry-job'",
      "UPDATE seo_editorial_jobs SET site_id='other' WHERE id='retry-job'",
      "UPDATE seo_editorial_jobs SET candidate_index=1 WHERE id='retry-job'",
      "UPDATE seo_review_continuation_retries SET previous_job_id='old-job'",
      "DELETE FROM seo_review_continuation_retries",
      "INSERT OR REPLACE INTO seo_review_continuation_retries SELECT * FROM seo_review_continuation_retries",
      "INSERT INTO seo_model_calls VALUES('bad','retry-job','generation','model','hash','retry-budget')",
      "INSERT INTO seo_budget_runs(id,article_key,created_at,deadline) VALUES('new-budget','article',200,300)",
    ])
      expect(() => db.exec(query), query).toThrow();
  } finally {
    db.close();
  }
});
it("0044 registers atomically in workerd D1 and holds the predecessor unchanged", async () => {
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
    await db.batch([
      db.prepare(freshRun),
      db.prepare(audit),
      db.prepare("INSERT INTO seo_review_effort_contracts VALUES('new-job',2)"),
      db.prepare(freshJob),
    ]);
    await db.exec(
      "UPDATE seo_editorial_jobs SET status='unresolved',github_run_id='123',callback_recorded=1 WHERE id='new-job';UPDATE seo_editorial_runs SET status='unresolved' WHERE run_id='new'",
    );
    const before = await db
      .prepare("SELECT * FROM seo_editorial_jobs WHERE id='new-job'")
      .first();
    await expect(
      db.batch([db.prepare(retryRun), db.prepare(retryAudit)]),
    ).rejects.toThrow();
    expect(
      await db.prepare("SELECT * FROM seo_review_continuation_retries").first(),
    ).toBeNull();
    await db.batch([
      db.prepare(retryRun),
      db.prepare(retryAudit),
      db.prepare(
        "INSERT INTO seo_review_effort_contracts VALUES('retry-job',2)",
      ),
      db.prepare(retryJob),
    ]);
    expect(
      await db
        .prepare("SELECT * FROM seo_editorial_jobs WHERE id='new-job'")
        .first(),
    ).toEqual(before);
    await expect(
      db.exec(
        "UPDATE seo_editorial_jobs SET status='queued' WHERE id='new-job'",
      ),
    ).rejects.toThrow();
    expect(
      (await db.prepare("SELECT count(*) n FROM seo_budget_calls").first())!.n,
    ).toBe(0);
  } finally {
    await mf.dispose();
  }
});
