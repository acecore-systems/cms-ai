import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { it, expect } from "vitest";
it("0042 leaves every old table row and schema definition untouched and cannot retrofit old jobs", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const file of readdirSync(new URL("../migrations/", import.meta.url))
      .filter((n) => n.endsWith(".sql") && n >= "0004" && n < "0042")
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
        new URL(
          "../migrations/0042_seo_retrieval_fallback.sql",
          import.meta.url,
        ),
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
          "SELECT COALESCE(p.version,1) version FROM seo_editorial_jobs j LEFT JOIN seo_retrieval_fallback_contracts p ON p.job_id=j.id WHERE j.id=?",
        )
        .get("old-job")!.version,
    ).toBe(1);
    expect(() =>
      db.exec(
        "INSERT INTO seo_retrieval_fallback_contracts VALUES('old-job',2)",
      ),
    ).toThrow("seo_retrieval_fallback_new_only");
    expect(() =>
      db.exec(
        "INSERT INTO seo_retrieval_fallback_contracts VALUES('orphan',2)",
      ),
    ).toThrow();
    expect(
      db
        .prepare("SELECT count(*) n FROM seo_retrieval_fallback_contracts")
        .get()!.n,
    ).toBe(0);
    db.exec(
      "BEGIN; INSERT INTO seo_retrieval_fallback_contracts VALUES('new-job',2); INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index) VALUES('new-job','old','wiki',1); COMMIT",
    );
    for (const sql of [
      "DELETE FROM seo_retrieval_fallback_contracts",
      "UPDATE seo_retrieval_fallback_contracts SET version=2",
      "INSERT OR REPLACE INTO seo_retrieval_fallback_contracts VALUES('new-job',2)",
      "UPDATE seo_editorial_jobs SET id='replaced' WHERE id='new-job'",
      "DELETE FROM seo_editorial_jobs WHERE id='new-job'",
    ])
      expect(() => db.exec(sql)).toThrow();
  } finally {
    db.close();
  }
});

it("0042 audit-before-job works in real D1 batch and orphan rolls back", async () => {
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
    for (const name of readdirSync(new URL("../migrations/", import.meta.url))
      .filter((n) => n.endsWith(".sql") && n >= "0004")
      .sort())
      await db.exec(
        readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8")
          .replace(/--[^\n]*/g, "")
          .replace(/\s+/g, " "),
      );
    await db.exec(
      "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at) VALUES('run','budget','hash',99,'[]',1)",
    );
    await expect(
      db.batch([
        db.prepare(
          "INSERT INTO seo_retrieval_fallback_contracts VALUES('orphan',2)",
        ),
      ]),
    ).rejects.toThrow();
    expect(
      (await db
        .prepare("SELECT count(*) n FROM seo_retrieval_fallback_contracts")
        .first())!.n,
    ).toBe(0);
    await db.batch([
      db.prepare(
        "INSERT INTO seo_retrieval_fallback_contracts VALUES('new',2)",
      ),
      db.prepare(
        "INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index) VALUES('new','run','wiki',0)",
      ),
    ]);
    expect(
      (await db
        .prepare("SELECT version FROM seo_retrieval_fallback_contracts")
        .first())!.version,
    ).toBe(2);
  } finally {
    await mf.dispose();
  }
});
