import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("adds v5 contracts without rewriting old schemas or rows and requires matching audit", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of readdirSync(new URL("../migrations/", import.meta.url))
      .filter((n) => n.endsWith(".sql") && n >= "0004" && n < "0048")
      .sort())
      db.exec(
        readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"),
      );
    db.exec(
      "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at) VALUES('old','old-budget','hash',99,'[]',1),('new','new-budget','hash',99,'[]',1)",
    );
    db.exec(
      "BEGIN; INSERT INTO seo_muse_job_models VALUES('old-job',4,'muse-ember-1.0','gpt-6-luna'); INSERT INTO seo_muse_generation_contracts VALUES('old-job',2,48000,'medium'); INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index) VALUES('old-job','old','wiki',0); COMMIT",
    );
    const oldSchema = db
      .prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name",
      )
      .all();
    const oldRows = db.prepare("SELECT * FROM seo_muse_job_models").all();
    db.exec(
      readFileSync(
        new URL("../migrations/0048_seo_parallel_models.sql", import.meta.url),
        "utf8",
      ),
    );
    for (const item of oldSchema as any[])
      expect(
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type=? AND name=?")
          .get(item.type, item.name),
      ).toEqual({ sql: item.sql });
    expect(db.prepare("SELECT * FROM seo_muse_job_models").all()).toEqual(
      oldRows,
    );
    expect(() =>
      db.exec(
        "INSERT INTO seo_v5_job_models VALUES('old-job',5,'muse-ember-1.0','parallel-free')",
      ),
    ).toThrow();
    db.exec(
      "BEGIN; INSERT INTO seo_v5_job_models VALUES('new-job',5,'muse-ember-1.0','parallel-free'); INSERT INTO seo_v5_generation_contracts VALUES('new-job',2,48000,'medium'); INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index,call_id) VALUES('new-job','new','wiki',0,'call'); COMMIT",
    );
    expect(() => db.exec("UPDATE seo_v5_job_models SET version=5")).toThrow();
    expect(() => db.exec("DELETE FROM seo_v5_generation_contracts")).toThrow();
    expect(() =>
      db.exec(
        "INSERT INTO seo_budget_calls(id,run_id,month_jst,request_sha256,reserved_micros,created_at) VALUES('call','new-budget','2026-11','hash',1,1)",
      ),
    ).toThrow();
    expect(() =>
      db.exec(
        "INSERT INTO seo_v5_parallel_searches VALUES('new-job','bad','" +
          "a".repeat(64) +
          "','" +
          "b".repeat(64) +
          "')",
      ),
    ).toThrow();
  } finally {
    db.close();
  }
});

it("adds immutable stage effort only to new v5 jobs and preserves legacy medium", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of readdirSync(new URL("../migrations/", import.meta.url))
      .filter((n) => n.endsWith(".sql") && n >= "0004" && n < "0049")
      .sort())
      db.exec(
        readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"),
      );
    db.exec(
      "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at) VALUES('old','old-budget','hash',99,'[]',1),('new','new-budget','hash',99,'[]',1)",
    );
    db.exec(
      "BEGIN; INSERT INTO seo_v5_job_models VALUES('old-job',5,'muse-ember-1.0','parallel-free'); INSERT INTO seo_v5_generation_contracts VALUES('old-job',2,48000,'medium'); INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index) VALUES('old-job','old','wiki',0); COMMIT",
    );
    const old = db.prepare("SELECT * FROM seo_v5_generation_contracts").all();
    db.exec(
      readFileSync(
        new URL("../migrations/0049_seo_muse_effort.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(
      db.prepare("SELECT * FROM seo_v5_generation_contracts").all(),
    ).toEqual(old);
    expect(() =>
      db.exec(
        "INSERT INTO seo_v5_effort_contracts VALUES('old-job',1,2,48000,'max')",
      ),
    ).toThrow();
    db.exec(
      "BEGIN; INSERT INTO seo_v5_job_models VALUES('new-job',5,'muse-ember-1.0','parallel-free'); INSERT INTO seo_v5_effort_contracts VALUES('new-job',1,2,48000,'max'); INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index) VALUES('new-job','new','wiki',0); COMMIT",
    );
    for (const query of [
      "UPDATE seo_v5_effort_contracts SET version=1",
      "DELETE FROM seo_v5_effort_contracts",
      "INSERT OR REPLACE INTO seo_v5_effort_contracts VALUES('new-job',1,2,48000,'max')",
      "INSERT INTO seo_v5_generation_contracts VALUES('new-job',2,48000,'medium')",
      "UPDATE seo_editorial_jobs SET run_id='old' WHERE id='new-job'",
      "DELETE FROM seo_editorial_jobs WHERE id='new-job'",
    ])
      expect(() => db.exec(query)).toThrow();
    expect(
      db
        .prepare(
          "SELECT generation_effort,max_completion_tokens FROM seo_v5_effort_contracts WHERE job_id='new-job'",
        )
        .get(),
    ).toEqual({ generation_effort: "max", max_completion_tokens: 48000 });
  } finally {
    db.close();
  }
});
