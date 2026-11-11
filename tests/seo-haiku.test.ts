import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env.ts";
import { SeoBudget } from "../src/seo-budget.ts";
import { seoResponse } from "../src/seo-responses.ts";
import { runTextModel } from "../src/inference.ts";
const HAIKU_MODEL = "claude-haiku-5-5";

it("rejects the historical model before provider calls or reservations", async () => {
  const fetcher = vi.fn(),
    reserve = vi.fn(),
    batch = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  try {
    await expect(
      runTextModel({} as AppEnv, HAIKU_MODEL, {}, reserve),
    ).rejects.toThrow("seo_haiku_retired");
    for (const phase of ["plan", "research", "review"] as const)
      await expect(
        seoResponse({ SEO_GENERATION_ENABLED: "true" } as AppEnv, {
          runId: "r",
          jobId: "j",
          modelVersion: 3,
          callId: "c",
          articleKey: "a",
          deadline: Date.now() + 10000,
          request: {},
          phase,
        }),
      ).rejects.toThrow("seo_haiku_retired");
    await expect(
      new SeoBudget({ batch } as unknown as AppEnv["CMS_AI_DB"]).reserve(
        "r",
        "c",
        "a",
        "h",
        1,
        Date.now(),
        Date.now() + 10000,
        1,
        { jobId: "j", phase: "plan", model: HAIKU_MODEL, modelVersion: 3 },
      ),
    ).rejects.toThrow("seo_haiku_retired");
    expect(fetcher).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("registers v3 atomically without rewriting v2 and enforces immutable audit", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of readdirSync(new URL("../migrations/", import.meta.url))
      .filter((n) => n.endsWith(".sql") && n >= "0004")
      .sort())
      db.exec(
        readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"),
      );
    db.exec(
      "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at) VALUES('root','budget','hash',99,'[]',1)",
    );
    db.exec(
      "BEGIN; INSERT INTO seo_haiku_job_models VALUES('new',3,'claude-haiku-5-5','gpt-6-luna'); INSERT INTO seo_generation_contracts VALUES('new',2,48000,'high'); INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index,call_id) VALUES('new','root','wiki',0,'call'); COMMIT",
    );
    expect(() =>
      db.exec("UPDATE seo_haiku_job_models SET version=3"),
    ).toThrow();
    expect(() =>
      db.exec(
        "INSERT INTO seo_job_models VALUES('new',2,'@cf/deepseek-ai/deepseek-v4.1-flash-1017','gpt-6-luna')",
      ),
    ).toThrow();
    expect(() =>
      db.exec(
        "INSERT INTO seo_budget_calls(id,run_id,month_jst,request_sha256,reserved_micros,created_at) VALUES('call','budget','2026-11','hash',1,1)",
      ),
    ).toThrow();
  } finally {
    db.close();
  }
});

it("migration keeps existing v2 rows unchanged and forbids backfilling v3 onto them", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const migrations = readdirSync(new URL("../migrations/", import.meta.url))
      .filter((n) => n.endsWith(".sql") && n >= "0004")
      .sort();
    for (const name of migrations.filter((n) => n < "0046"))
      db.exec(
        readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"),
      );
    db.exec(
      "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at) VALUES('old','old-budget','hash',99,'[]',1)",
    );
    db.exec(
      "BEGIN; INSERT INTO seo_job_models VALUES('old-job',2,'@cf/deepseek-ai/deepseek-v4.1-flash-1017','gpt-6-luna'); INSERT INTO seo_generation_contracts VALUES('old-job',2,48000,'high'); INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index) VALUES('old-job','old','wiki',0); COMMIT",
    );
    const before = db.prepare("SELECT * FROM seo_job_models").all();
    db.exec(
      readFileSync(
        new URL("../migrations/0046_seo_haiku_models.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(db.prepare("SELECT * FROM seo_job_models").all()).toEqual(before);
    expect(() =>
      db.exec(
        "INSERT INTO seo_haiku_job_models VALUES('old-job',3,'claude-haiku-5-5','gpt-6-luna')",
      ),
    ).toThrow();
    expect(
      db.prepare("SELECT count(*) n FROM seo_haiku_job_models").get()!.n,
    ).toBe(0);
  } finally {
    db.close();
  }
});

it("workerd D1 atomically registers v3 and requires its matching audit for reservations", async () => {
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
    const run = "seo-00000000-0000-4000-8000-000000000001",
      call = "seo-00000000-0000-4000-8000-000000000002",
      now = Date.parse("2026-11-03T01:00:00Z");
    await db
      .prepare(
        "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at) VALUES('root',?,'hash',?,'[]',?)",
      )
      .bind(run, now + 60000, now)
      .run();
    await expect(
      db.batch([
        db.prepare(
          "INSERT INTO seo_haiku_job_models VALUES('orphan',3,'claude-haiku-5-5','gpt-6-luna')",
        ),
      ]),
    ).rejects.toThrow();
    await db.batch([
      db.prepare(
        "INSERT INTO seo_haiku_job_models VALUES('new',3,'claude-haiku-5-5','gpt-6-luna')",
      ),
      db.prepare(
        "INSERT INTO seo_generation_contracts VALUES('new',2,48000,'high')",
      ),
      db
        .prepare(
          "INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index,call_id) VALUES('new','root','wiki',0,?)",
        )
        .bind(call),
    ]);
    const budget = new SeoBudget(db as unknown as AppEnv["CMS_AI_DB"]);
    await expect(
      budget.reserve(
        run,
        call,
        "wiki:test",
        "a".repeat(64),
        1000,
        now,
        now + 60000,
        2,
      ),
    ).rejects.toThrow();
    await expect(
      budget.reserve(
        run,
        call,
        "wiki:test",
        "a".repeat(64),
        1000,
        now,
        now + 60000,
        2,
        {
          jobId: "new",
          phase: "generation",
          model: HAIKU_MODEL,
          modelVersion: 3,
        },
      ),
    ).rejects.toThrow("seo_haiku_retired");
    expect(
      await db.prepare("SELECT * FROM seo_haiku_model_calls").all(),
    ).toMatchObject({ results: [] });
    expect(
      await db.prepare("SELECT * FROM seo_budget_calls").all(),
    ).toMatchObject({ results: [] });
  } finally {
    await mf.dispose();
  }
});
