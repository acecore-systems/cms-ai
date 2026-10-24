import { readFileSync, readdirSync } from "node:fs";
import * as miniflare from "miniflare";
import { it, expect } from "vitest";
import { SeoBudget } from "../src/seo-budget.ts";
import { SEO_DEEPSEEK } from "../src/seo-deepseek.ts";

it("D1 atomically requires audit and preserves October weekly reserve across competing reservations", async () => {
  const options = {
    modules: true,
    script: "export default {fetch(){return new Response(null)}}",
    compatibilityDate: "2026-09-01",
    d1Databases: ["DB"],
  };
  const convert = (miniflare as any).convertV4MiniflareOptions;
  const mf = new miniflare.Miniflare(convert ? convert(options) : options);
  try {
    const db = await mf.getD1Database("DB");
    for (const name of readdirSync(new URL("../migrations/", import.meta.url))
      .filter((n) => n.endsWith(".sql") && n >= "0004")
      .sort()) {
      const sql = readFileSync(
        new URL("../migrations/" + name, import.meta.url),
        "utf8",
      )
        .replace(/--[^\n]*/g, "")
        .replace(/\s+/g, " ");
      await db.exec(sql);
    }
    const now = Date.parse("2026-10-23T00:00:00Z"),
      deadline = now + 1800000,
      hash = "a".repeat(64);
    const id = (n: number) =>
      "seo-00000000-0000-4000-8000-" + String(n).padStart(12, "0");
    const budget = new SeoBudget(db as unknown as D1Database);
    // Historical rows are left intact; consume all but one micro of the retained-month cap.
    for (let i = 0; i < 11; i++)
      await budget.reserve(
        id(i),
        id(100 + i),
        "old" + i,
        hash,
        i === 10 ? 849999 : 1000000,
        now,
        deadline,
        2,
      );
    const run = id(30),
      job = "new-job",
      article = "wiki:article/example.md";
    await db.batch([
      db
        .prepare(
          "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at) VALUES('root',?,?,?,'[]',?)",
        )
        .bind(run, hash, deadline, now),
      db.prepare("INSERT INTO seo_plan_contracts VALUES(?,2)").bind(job),
      db
        .prepare("INSERT INTO seo_job_models VALUES(?,2,?,'gpt-6-luna')")
        .bind(job, SEO_DEEPSEEK),
      db
        .prepare(
          "INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index,call_id) VALUES(?,'root','wiki',0,?)",
        )
        .bind(job, id(200)),
    ]);
    // New plan contract can precede its job only inside one atomic batch.
    await expect(
      db.batch([
        db.prepare("INSERT INTO seo_plan_contracts VALUES('orphan',2)"),
      ]),
    ).rejects.toThrow();
    expect(
      (await db
        .prepare(
          "SELECT count(*) n FROM seo_plan_contracts WHERE job_id='orphan'",
        )
        .first())!.n,
    ).toBe(0);
    await db
      .prepare(
        "INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index) VALUES('legacy-job','root','wiki',1)",
      )
      .run();
    expect(
      (await db
        .prepare(
          "SELECT COALESCE(p.version,1) version FROM seo_editorial_jobs j LEFT JOIN seo_plan_contracts p ON p.job_id=j.id WHERE j.id='legacy-job'",
        )
        .first())!.version,
    ).toBe(1);
    await expect(
      db.prepare("INSERT INTO seo_plan_contracts VALUES('legacy-job',2)").run(),
    ).rejects.toThrow("seo_plan_new_only");
    expect(
      (await db
        .prepare("SELECT version FROM seo_plan_contracts WHERE job_id=?")
        .bind(job)
        .first())!.version,
    ).toBe(2);
    const before = await db
      .prepare("SELECT * FROM seo_budget_calls ORDER BY id")
      .all();
    await expect(
      budget.reserve(run, id(200), article, hash, 1, now, deadline, 2),
    ).rejects.toThrow("seo_model_audit_required");
    await expect(
      budget.reserve(run, id(200), article, hash, 2, now, deadline, 2, {
        jobId: job,
        phase: "generation",
        model: SEO_DEEPSEEK,
      }),
    ).rejects.toThrow("seo_october_slot_reserved");
    expect(
      (await db.prepare("SELECT count(*) n FROM seo_model_calls").first())!.n,
    ).toBe(0);
    expect(
      await db.prepare("SELECT * FROM seo_budget_calls ORDER BY id").all(),
    ).toMatchObject({ results: before.results });
    const results = await Promise.allSettled(
      [1, 1].map(() =>
        budget.reserve(run, id(200), article, hash, 1, now, deadline, 2, {
          jobId: job,
          phase: "generation",
          model: SEO_DEEPSEEK,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (await db
        .prepare("SELECT sum(reserved_micros) n FROM seo_budget_calls")
        .first())!.n,
    ).toBe(10850000);
    expect(
      (await db.prepare("SELECT count(*) n FROM seo_model_calls").first())!.n,
    ).toBe(1);
  } finally {
    await mf.dispose();
  }
}, 30000);
