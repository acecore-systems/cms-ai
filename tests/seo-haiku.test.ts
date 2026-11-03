import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { HAIKU_MODEL } from "../src/anthropic.ts";
import type { AppEnv } from "../src/env.ts";
import { runTextModel } from "../src/inference.ts";
import { fallbackMaximum } from "../src/seo-fallback.ts";
import { allocateGenerationInputs } from "../src/seo-stage-budget.ts";
import { SeoBudget } from "../src/seo-budget.ts";
import {
  haikuPayload,
  haikuUpperCost,
  haikuCostBound,
} from "../src/seo-haiku.ts";

const request = {
  messages: [
    { role: "system", content: "system" },
    { role: "user", content: "input" },
  ],
  max_completion_tokens: 12000,
  reasoning_effort: "high",
  response_format: {
    type: "json_schema",
    json_schema: {
      type: "object",
      properties: { value: { type: "string", maxLength: 5 } },
      required: ["value"],
      additionalProperties: false,
    },
  },
};
const result = {
  type: "message",
  role: "assistant",
  model: HAIKU_MODEL,
  id: "msg_fixture",
  stop_reason: "end_turn",
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  content: [{ type: "text", text: '{"value":"ok"}' }],
};
afterEach(() => vi.unstubAllGlobals());

it("keeps Haiku rates usable past the former expiry with bounded requests", () => {
  const payload = haikuPayload(request);
  const baseline = haikuUpperCost(payload, Date.parse("2026-11-04T00:00:00Z"));
  for (const future of ["2026-11-19T00:00:00Z", "2099-01-01T00:00:00Z"])
    expect(haikuUpperCost(payload, Date.parse(future))).toBe(baseline);
  for (const invalid of [NaN, Infinity, -Infinity])
    expect(() => haikuUpperCost(payload, invalid)).toThrow();
  expect(() => haikuUpperCost({ ...payload, max_tokens: 48001 })).toThrow();
});

it("bounds the exact Haiku request at long-context rates, reserves before sending, then saves raw before validation", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      calls.push("fetch");
      expect(JSON.parse(init.body)).toEqual(haikuPayload(request));
      return new Response(JSON.stringify(result));
    }),
  );
  const payload = haikuPayload(request);
  expect(haikuUpperCost(payload)).toBe(
    Math.ceil(
      (new TextEncoder().encode(JSON.stringify(payload)).length + 8192) * 0.5 +
        12000 * 2.5,
    ),
  );
  const raw = await runTextModel(
    { ANTHROPIC_API_KEY: "fixture" } as AppEnv,
    HAIKU_MODEL,
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
  expect((raw as any).choices[0].message.content).toBe('{"value":"ok"}');
});

it("uses the long rate on both sides of the 100k threshold", () => {
  expect(haikuCostBound(91808, 12000)).toBe(80000);
  expect(haikuCostBound(91809, 12000)).toBe(80001);
});

it("one language fits but nine languages stop at the unchanged run ceiling", () => {
  const allocation = allocateGenerationInputs(
    Array.from({ length: 9 }, (_, i) => ({ path: `${i}.md`, bytes: 1000 })),
    2,
    2,
  );
  expect(() => fallbackMaximum(allocation, 3, 2)).toThrow(
    "seo_fallback_budget",
  );
  expect(
    fallbackMaximum(
      allocateGenerationInputs([{ path: "ja.md", bytes: 1000 }], 2, 2),
      3,
      2,
    ),
  ).toBeLessThanOrEqual(1_250_000);
});

it("records maxima by standard locale count with a 1000-byte baseline per file", () => {
  const maximums = Array.from({ length: 9 }, (_, i) => {
    const allocation = allocateGenerationInputs(
      Array.from({ length: i + 1 }, (_, j) => ({
        path: `${j}.md`,
        bytes: 1000,
      })),
      2,
      2,
    );
    try {
      return fallbackMaximum(allocation, 3, 2);
    } catch {
      return null;
    }
  });
  console.info("haiku_locale_maximum_microusd", JSON.stringify(maximums));
  expect(maximums[0]).not.toBeNull();
  expect(maximums[8]).toBeNull();
});

it.each([
  { ...result, stop_reason: "max_tokens" },
  { ...result, content: [{ type: "text", text: '{"value":"too long"}' }] },
  { ...result, usage: { ...result.usage, cache_creation_input_tokens: 1 } },
  { ...result, usage: { ...result.usage, output_tokens: 12001 } },
])(
  "keeps the saved provider evidence and rejects invalid, incomplete or unbounded responses",
  async (body) => {
    const save = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body))),
    );
    await expect(
      runTextModel(
        { ANTHROPIC_API_KEY: "fixture" } as AppEnv,
        HAIKU_MODEL,
        request,
        async () => {},
        Date.now() + 60000,
        true,
        save,
      ),
    ).rejects.toThrow();
    expect(save).toHaveBeenCalledOnce();
  },
);

it("never calls DeepSeek for a v2 job", async () => {
  const run = vi.fn(),
    reserve = vi.fn();
  await expect(
    runTextModel(
      { AI: { run } } as unknown as AppEnv,
      "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
      request,
      reserve,
      Date.now() + 60000,
      true,
    ),
  ).rejects.toThrow("seo_deepseek_retired");
  expect(run).not.toHaveBeenCalled();
  expect(reserve).not.toHaveBeenCalled();
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
        model: HAIKU_MODEL,
        modelVersion: 3,
      },
    );
    expect(
      await db
        .prepare(
          "SELECT model,request_sha256 FROM seo_haiku_model_calls WHERE call_id=?",
        )
        .bind(call)
        .first(),
    ).toMatchObject({ model: HAIKU_MODEL, request_sha256: "a".repeat(64) });
    expect(
      (await db
        .prepare("SELECT reserved_micros FROM seo_budget_calls WHERE id=?")
        .bind(call)
        .first())!.reserved_micros,
    ).toBe(1000);
  } finally {
    await mf.dispose();
  }
});
