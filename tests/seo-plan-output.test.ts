import { readFileSync, readdirSync } from "node:fs";
import * as miniflare from "miniflare";
import { assertPlanOutputPreflight } from "../src/seo-plan-output.ts";
import { expect, it, vi, afterEach } from "vitest";
import { buildPlanRequest } from "../src/seo-checks.ts";
import {
  deepseekPayload,
  deepseekUpperCost,
  SEO_DEEPSEEK,
} from "../src/seo-deepseek.ts";
import {
  allocateGenerationInputs,
  assertStageInput,
} from "../src/seo-stage-budget.ts";
import { fallbackMaximum } from "../src/seo-fallback.ts";
import { seoTextResponse } from "../src/seo-text-response.ts";
import { sha256 } from "../src/seo-hash.ts";
import type { AppEnv } from "../src/env.ts";
const now = Date.parse("2026-10-25T00:00:00Z");
afterEach(() => vi.restoreAllMocks());
const source =
  "---\ntitle: Fixture\n---\nWidgetは条件が有効な場合だけ記録します。\n";
const request = () => buildPlanRequest(source, 2, 2, undefined, 1, 1, 2);
it("uses the same 24k request for current plan reservation without changing legacy Responses", () => {
  expect(buildPlanRequest(source, 2).max_output_tokens).toBe(6000);
  const payload = deepseekPayload(request(), true);
  expect(payload.max_completion_tokens).toBe(24000);
  assertStageInput("plan", payload, 2, 2);
  // Compare exact serialized maxima, not estimates of model use.
  for (let count = 1; count <= 9; count++) {
    const allocation = allocateGenerationInputs(
      Array.from({ length: count }, (_, i) => ({
        path: i + ".md",
        bytes: 100,
      })),
      2,
      2,
    );
    const cost = (input: number, output: number) =>
      Math.ceil(((input + 8192) * 3 + output * 12) / 10);
    const oldText =
      cost(32000, 6000) +
      cost(440000, 24000) +
      allocation.reduce((n, a) => n + cost(a.maxBytes, 48000), 0);
    const hosted =
      Math.ceil((128000 + 8000 + 8192) * 2 * 0.3 + 10000 + 6000) +
      Math.ceil((128000 + 8000 + 8192) * 3 * 0.3 + 20000 + 6000);
    expect(fallbackMaximum(allocation, 2, 2)).toBe(oldText + hosted + 21600);
    expect(fallbackMaximum(allocation, 2, 2)).toBeLessThanOrEqual(1250000);
  }
});
async function fixture(kind = "valid") {
  const req = request(),
    payload = deepseekPayload(req, true);
  const allocation = allocateGenerationInputs(
    [{ path: "one.md", bytes: 100 }],
    2,
    2,
  );
  const maximum = fallbackMaximum(allocation, 2, 2);
  const saved: any = {
    modelVersion: 2,
    modelMaximumMicros: maximum,
    maximumMicros: maximum,
    fallbackVersion: 1,
    generationAllocation: allocation,
    planBytes: Buffer.byteLength(JSON.stringify(payload)),
  };
  if (kind === "old") saved.modelMaximumMicros -= 21600;
  if (kind === "fallback") saved.maximumMicros--;
  if (kind === "bytes") saved.planBytes--;
  const raw = JSON.stringify(saved),
    hash = await sha256(raw);
  const finish = vi.fn(async () => ({ meta: { changes: 1 } }));
  const batch = vi.fn(async () => [
    { meta: { changes: 1 } },
    { meta: { changes: 1 } },
    { meta: { changes: 1 } },
  ]);
  const put = vi.fn(async (..._args: unknown[]) => ({}));
  const response = {
    model: SEO_DEEPSEEK,
    choices: [
      {
        finish_reason: "length",
        message: {
          role: "assistant",
          content: "",
          reasoning_content: "synthetic private reasoning",
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 24000 },
  };
  const ai = vi.fn(async (..._args: unknown[]) => response);
  const env = {
    AI: { run: ai },
    CMS_AI_IMAGES: {
      get: async () => (kind === "missing" ? null : { text: async () => raw }),
      put,
    },
    CMS_AI_DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            input_allocation_sha256: kind === "hash" ? "x" : hash,
            generation_output: 2,
          }),
          run: finish,
        }),
      }),
      batch,
    },
  } as unknown as AppEnv;
  const args = {
    jobId: "job",
    runId: "seo-00000000-0000-4000-8000-000000000001",
    callId: "seo-00000000-0000-4000-8000-000000000002",
    articleKey: "fixture",
    deadline: now + 600000,
    phase: "plan" as const,
    budgetVersion: 2,
    recovery: 2,
    request: req,
  };
  return { env, args, ai, batch, put, finish, response, payload };
}
it.each(["old", "fallback", "bytes", "hash", "missing"])(
  "rejects %s preflight before reservation and provider call",
  async (kind) => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const f = await fixture(kind);
    await expect(seoTextResponse(f.env, f.args)).rejects.toThrow(
      "seo_research_call",
    );
    expect(f.batch).not.toHaveBeenCalled();
    expect(f.ai).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
  },
);
it.each([6000, 24000])(
  "stores length/empty raw at %i tokens, leaves reservation unresolved and never retries",
  async (tokens) => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const timeout = vi.spyOn(AbortSignal, "timeout"),
      f = await fixture();
    f.response.usage.completion_tokens = tokens;
    await expect(seoTextResponse(f.env, f.args)).rejects.toThrow(
      "seo_research_call",
    );
    expect(f.ai).toHaveBeenCalledTimes(1);
    expect(f.batch).toHaveBeenCalledTimes(1);
    expect(f.ai.mock.calls[0][1]).toEqual(f.payload);
    expect(deepseekUpperCost(f.payload)).toBeGreaterThan(24000 * 1.2);
    expect(timeout).toHaveBeenLastCalledWith(480000);
    expect(f.put).toHaveBeenCalledTimes(1);
    expect(f.put.mock.calls[0][0]).toContain("seo-provider-responses/");
    expect(f.finish).toHaveBeenCalledTimes(1);
  },
);
it("clips the 24k wait to the original deadline", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const timeout = vi.spyOn(AbortSignal, "timeout"),
    f = await fixture();
  await expect(
    seoTextResponse(f.env, { ...f.args, deadline: now + 20000 }),
  ).rejects.toThrow();
  expect(timeout).toHaveBeenLastCalledWith(20000);
  expect(f.ai).toHaveBeenCalledTimes(1);
});

it("loads the generation contract from real D1 schema, preserves rows and rejects stale estimates", async () => {
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
      .sort())
      await db.exec(
        readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8")
          .replace(/--[^\n]*/g, "")
          .replace(/\s+/g, " "),
      );
    const payload = deepseekPayload(request(), true),
      allocation = allocateGenerationInputs(
        [{ path: "one.md", bytes: 100 }],
        2,
        2,
      );
    for (const generation of [1, 2])
      for (const stale of [false, true]) {
        const job = "job-" + generation + "-" + stale,
          budget = "budget-" + job;
        const maximum =
          fallbackMaximum(allocation, 2, generation) - (stale ? 21600 : 0);
        const raw = JSON.stringify({
          modelVersion: 2,
          modelMaximumMicros: maximum,
          generationAllocation: allocation,
          planBytes: Buffer.byteLength(JSON.stringify(payload)),
        });
        const rows = [
          db
            .prepare(
              "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at) VALUES(?,?,'hash',9999999999999,'[]',1)",
            )
            .bind(job, budget),
        ];
        if (generation === 2)
          rows.push(
            db
              .prepare("INSERT INTO seo_job_models VALUES(?,2,?,'gpt-6-luna')")
              .bind(job, SEO_DEEPSEEK),
            db
              .prepare(
                "INSERT INTO seo_generation_contracts VALUES(?,2,48000,'high')",
              )
              .bind(job),
          );
        rows.push(
          db
            .prepare(
              "INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index,input_allocation_sha256) VALUES(?,?,'wiki',0,?)",
            )
            .bind(job, job, await sha256(raw)),
        );
        await db.batch(rows);
        const env = {
          CMS_AI_DB: db,
          CMS_AI_IMAGES: { get: async () => ({ text: async () => raw }) },
        } as unknown as AppEnv;
        const before = await db
          .prepare("SELECT * FROM seo_editorial_jobs ORDER BY id")
          .all();
        const checking = assertPlanOutputPreflight(env, job, budget, payload);
        if (stale)
          await expect(checking).rejects.toThrow("seo_plan_preflight_mismatch");
        else await expect(checking).resolves.toBeUndefined();
        await expect(
          assertPlanOutputPreflight(env, job, "other-budget", payload),
        ).rejects.toThrow();
        expect(
          (
            await db
              .prepare("SELECT * FROM seo_editorial_jobs ORDER BY id")
              .all()
          ).results,
        ).toEqual(before.results);
        expect(
          await db
            .prepare("SELECT count(*) n FROM seo_budget_calls")
            .first("n"),
        ).toBe(0);
      }
  } finally {
    await mf.dispose();
  }
}, 30000);
