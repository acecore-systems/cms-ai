import { afterEach, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env.ts";
import { MUSE_MODEL } from "../src/meta.ts";
import { runTextModel } from "../src/inference.ts";
import { museCostBound, musePayload, museUpperCost } from "../src/seo-muse.ts";
import { seoMuseEffort } from "../src/seo-muse-effort.ts";
import { SeoBudget, sha256 } from "../src/seo-budget.ts";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";

const request = {
  messages: [
    { role: "system", content: "system" },
    { role: "user", content: "input" },
  ],
  max_completion_tokens: 12000,
  response_format: {
    type: "json_schema",
    json_schema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
};
afterEach(() => vi.unstubAllGlobals());

it("reserves long-context rates and records the response before validating it", async () => {
  const calls: string[] = [];
  const payload = musePayload({ ...request, reasoning_effort: "max" });
  expect(payload.reasoning_effort).toBe("medium");
  expect(museUpperCost(payload)).toBe(
    museCostBound(
      new TextEncoder().encode(JSON.stringify(payload)).length,
      12000,
    ),
  );
  expect(museCostBound(191808, 12000)).toBe(78000);
  expect(museCostBound(191809, 12000)).toBe(78001);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls.push("fetch");
      return new Response(
        JSON.stringify({
          model: MUSE_MODEL,
          usage: { prompt_tokens: 100, completion_tokens: 20 },
          choices: [
            { finish_reason: "stop", message: { content: '{"value":"ok"}' } },
          ],
        }),
      );
    }),
  );
  const result = await runTextModel(
    { META_API_KEY_STORE: { get: async () => "fixture" } } as AppEnv,
    MUSE_MODEL,
    request,
    async (_model, actual) => {
      calls.push("reserve");
      expect(actual).toEqual(payload);
    },
    Date.now() + 60000,
    true,
    async () => {
      calls.push("save");
    },
  );
  expect(calls).toEqual(["reserve", "fetch", "save"]);
  expect((result as any).choices[0].message.content).toBe('{"value":"ok"}');
});

it("preserves v3 rows and enforces separate immutable v4 model and medium generation contracts", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of readdirSync(new URL("../migrations/", import.meta.url))
      .filter((n) => n.endsWith(".sql") && n >= "0004" && n < "0047")
      .sort())
      db.exec(
        readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"),
      );
    db.exec(
      "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at) VALUES('old','old-budget','hash',99,'[]',1),('new','new-budget','hash',99,'[]',1)",
    );
    db.exec(
      "BEGIN; INSERT INTO seo_haiku_job_models VALUES('old-job',3,'claude-haiku-5-5','gpt-6-luna'); INSERT INTO seo_generation_contracts VALUES('old-job',2,48000,'high'); INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index) VALUES('old-job','old','wiki',0); COMMIT",
    );
    const before = db.prepare("SELECT * FROM seo_haiku_job_models").all();
    const oldTrigger = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name='seo_generation_model_required'",
      )
      .get();
    db.exec(
      readFileSync(
        new URL("../migrations/0047_seo_muse_models.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(db.prepare("SELECT * FROM seo_haiku_job_models").all()).toEqual(
      before,
    );
    expect(
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name='seo_generation_model_required'",
        )
        .get(),
    ).toEqual(oldTrigger);
    expect(() =>
      db.exec(
        "INSERT INTO seo_muse_job_models VALUES('old-job',4,'muse-ember-1.0','gpt-6-luna')",
      ),
    ).toThrow();
    db.exec(
      "BEGIN; INSERT INTO seo_muse_job_models VALUES('new-job',4,'muse-ember-1.0','gpt-6-luna'); INSERT INTO seo_muse_generation_contracts VALUES('new-job',2,48000,'medium'); INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index,call_id) VALUES('new-job','new','wiki',0,'call'); COMMIT",
    );
    expect(() => db.exec("UPDATE seo_muse_job_models SET version=4")).toThrow();
    expect(() =>
      db.exec("DELETE FROM seo_muse_generation_contracts"),
    ).toThrow();
    expect(() =>
      db.exec(
        "INSERT INTO seo_budget_calls(id,run_id,month_jst,request_sha256,reserved_micros,created_at) VALUES('call','new-budget','2026-11','hash',1,1)",
      ),
    ).toThrow();
  } finally {
    db.close();
  }
});

it("workerd D1 atomically registers v4 and requires its matching audit for reservations", async () => {
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
      .filter((n) => n.endsWith(".sql") && n.includes("_seo_") && n >= "0004")
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
          "INSERT INTO seo_muse_job_models VALUES('orphan',4,'muse-ember-1.0','gpt-6-luna')",
        ),
      ]),
    ).rejects.toThrow();
    await db.batch([
      db.prepare(
        "INSERT INTO seo_muse_job_models VALUES('new',4,'muse-ember-1.0','gpt-6-luna')",
      ),
      db.prepare(
        "INSERT INTO seo_muse_generation_contracts VALUES('new',2,48000,'medium')",
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
    await budget.reserve(
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
        model: MUSE_MODEL,
        modelVersion: 4,
      },
    );
    expect(
      await db
        .prepare(
          "SELECT model,request_sha256 FROM seo_muse_model_calls WHERE call_id=?",
        )
        .bind(call)
        .first(),
    ).toMatchObject({ model: MUSE_MODEL, request_sha256: "a".repeat(64) });
    expect(
      (await db
        .prepare("SELECT reserved_micros FROM seo_budget_calls WHERE id=?")
        .bind(call)
        .first())!.reserved_micros,
    ).toBe(1000);
    // The new contract and model are committed atomically with their job in D1.
    const run2 = "seo-00000000-0000-4000-8000-000000000003";
    const call2 = "seo-00000000-0000-4000-8000-000000000004";
    await db
      .prepare(
        "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at) VALUES('root2',?,'hash',?,'[]',?)",
      )
      .bind(run2, now + 60000, now)
      .run();
    await expect(
      db.batch([
        db.prepare(
          "INSERT INTO seo_v5_job_models VALUES('orphan5',5,'muse-ember-1.0','parallel-free')",
        ),
        db.prepare(
          "INSERT INTO seo_v5_effort_contracts VALUES('orphan5',1,2,48000,'max')",
        ),
      ]),
    ).rejects.toThrow();
    expect(
      await db
        .prepare(
          "SELECT job_id FROM seo_v5_effort_contracts WHERE job_id='orphan5'",
        )
        .first(),
    ).toBeNull();
    await db.batch([
      db.prepare(
        "INSERT INTO seo_v5_job_models VALUES('new5',5,'muse-ember-1.0','parallel-free')",
      ),
      db.prepare(
        "INSERT INTO seo_v5_effort_contracts VALUES('new5',1,2,48000,'max')",
      ),
      db
        .prepare(
          "INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index,call_id) VALUES('new5','root2','wiki',0,?)",
        )
        .bind(call2),
    ]);
    const payload = musePayload(
      { ...request, max_completion_tokens: 48000 },
      false,
      "max",
    );
    const hash = await sha256(JSON.stringify(payload));
    const audit = {
      jobId: "new5",
      phase: "generation" as const,
      model: MUSE_MODEL,
      modelVersion: 5 as const,
    };
    await expect(
      budget.reserve(
        run2,
        call2,
        "wiki:test",
        hash,
        1250001,
        now,
        now + 60000,
        2,
        audit,
      ),
    ).rejects.toThrow();
    await budget.reserve(
      run2,
      call2,
      "wiki:test",
      hash,
      museUpperCost(payload),
      now,
      now + 60000,
      2,
      audit,
    );
    expect(
      await db
        .prepare(
          "SELECT m.request_sha256,b.request_sha256 AS charged,b.reserved_micros FROM seo_v5_model_calls m JOIN seo_budget_calls b ON b.id=m.call_id WHERE m.call_id=?",
        )
        .bind(call2)
        .first(),
    ).toMatchObject({
      request_sha256: hash,
      charged: hash,
      reserved_micros: museUpperCost(payload),
    });
    await expect(
      db
        .prepare(
          "UPDATE seo_v5_effort_contracts SET version=1 WHERE job_id='new5'",
        )
        .run(),
    ).rejects.toThrow();
  } finally {
    await mf.dispose();
  }
});

it("pins legacy medium and bounds each new stage including reasoning tokens", () => {
  const phases = [
    "discovery",
    "research",
    "plan",
    "generation",
    "review",
  ] as const;
  expect(phases.map((phase) => seoMuseEffort(0, phase))).toEqual([
    "medium",
    "medium",
    "medium",
    "medium",
    "medium",
  ]);
  expect(phases.map((phase) => seoMuseEffort(1, phase))).toEqual([
    "low",
    "medium",
    "medium",
    "max",
    "max",
  ]);
  for (const phase of phases) {
    const payload = musePayload(request, false, seoMuseEffort(1, phase));
    expect(payload.reasoning_effort).toBe(seoMuseEffort(1, phase));
    expect(museUpperCost(payload)).toBe(
      museCostBound(
        new TextEncoder().encode(JSON.stringify(payload)).length,
        12000,
      ),
    );
  }
});
