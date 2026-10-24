import { seoTextResponse } from "../src/seo-text-response.ts";
import { newJobMonthLimit } from "../src/seo-budget.ts";
import { it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  deepseekPayload,
  deepseekUpperCost,
  validateDeepseekResponse,
  SEO_DEEPSEEK,
} from "../src/seo-deepseek.ts";
import { runTextModel } from "../src/inference.ts";
import { fallbackMaximum } from "../src/seo-fallback.ts";
import { allocateGenerationInputs } from "../src/seo-stage-budget.ts";
import type { AppEnv } from "../src/env.ts";
const now = Date.parse("2026-10-23T00:00:00Z");
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now));
afterEach(() => vi.restoreAllMocks());
const request = () => ({
  messages: [
    { role: "system", content: "schema" },
    { role: "user", content: "source" },
  ],
  reasoning_effort: "high",
  max_completion_tokens: 6000,
  response_format: {
    type: "json_schema",
    json_schema: {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
    },
  },
});
const response = () => ({
  model: SEO_DEEPSEEK,
  choices: [
    {
      finish_reason: "stop",
      message: { role: "assistant", content: '{"ok":true}' },
    },
  ],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 100,
    completion_tokens_details: { reasoning_tokens: 90 },
  },
});
it("reserves exactly the final payload before one binding call, passes signal and validates all output tokens", async () => {
  const events: string[] = [];
  const ai = vi.fn(async (model, input, options) => {
    events.push("call");
    expect(model).toBe(SEO_DEEPSEEK);
    expect(input).toEqual(deepseekPayload(request()));
    expect(options.signal).toBeInstanceOf(AbortSignal);
    return response();
  });
  await runTextModel(
    { AI: { run: ai } } as unknown as AppEnv,
    SEO_DEEPSEEK,
    request(),
    async (_m, input) => {
      events.push("reserved");
      expect(deepseekUpperCost(input)).toBe(
        Math.ceil(
          ((new TextEncoder().encode(JSON.stringify(input)).length + 8192) * 3 +
            6000 * 12) /
            10,
        ),
      );
    },
    now + 60000,
    true,
  );
  expect(events).toEqual(["reserved", "call"]);
  expect(ai).toHaveBeenCalledTimes(1);
});
it.each([
  "missing-usage",
  "length",
  "tool",
  "extra",
  "truncated",
  "missing-finish",
  "too-many-output",
  "thinking-overflow",
  "wrong-model",
  "late",
])("rejects %s without retry", async (kind) => {
  const raw: any = response();
  if (kind === "missing-usage") delete raw.usage;
  if (kind === "length") raw.choices[0].finish_reason = "length";
  if (kind === "tool") raw.choices[0].message.tool_calls = [];
  if (kind === "extra")
    raw.choices[0].message.content = '{"ok":true,"extra":1}';
  if (kind === "truncated") raw.choices[0].message.content = '{"ok":';
  if (kind === "missing-finish") delete raw.choices[0].finish_reason;
  if (kind === "too-many-output") raw.usage.completion_tokens = 6001;
  if (kind === "thinking-overflow")
    raw.usage.completion_tokens_details.reasoning_tokens = 101;
  if (kind === "wrong-model") raw.model = "other";
  const ai = vi.fn(async () => {
    if (kind === "late") vi.mocked(Date.now).mockReturnValue(now + 60001);
    return raw;
  });
  await expect(
    runTextModel(
      { AI: { run: ai } } as unknown as AppEnv,
      SEO_DEEPSEEK,
      request(),
      async () => {},
      now + 60000,
      true,
    ),
  ).rejects.toThrow();
  expect(ai).toHaveBeenCalledTimes(1);
});
it("never calls the provider after failed reservation or expired deadline; old generic beforeRequest remains forbidden", async () => {
  const ai = vi.fn(),
    env = { AI: { run: ai } } as unknown as AppEnv;
  await expect(
    runTextModel(
      env,
      SEO_DEEPSEEK,
      request(),
      async () => {
        throw Error("cap");
      },
      now + 1,
      true,
    ),
  ).rejects.toThrow("cap");
  await expect(
    runTextModel(env, SEO_DEEPSEEK, request(), async () => {}, now, true),
  ).rejects.toThrow();
  await expect(
    runTextModel(env, SEO_DEEPSEEK, request(), async () => {}, now + 1),
  ).rejects.toThrow("seo_model_not_allowed");
  expect(ai).not.toHaveBeenCalled();
});
it("rejects tools/store/stream/unsupported effort/rates and never refunds cached tokens", () => {
  const p = deepseekPayload(request());
  for (const bad of [
    { ...p, store: true },
    { ...p, tools: [] },
    { ...p, stream: true },
    { ...p, reasoning_effort: "max" },
  ])
    expect(() => deepseekUpperCost(bad)).toThrow();
  expect(() =>
    deepseekUpperCost(p, Date.parse("2026-11-19T00:00:00Z")),
  ).toThrow();
  expect(() => validateDeepseekResponse(response(), p, now)).toThrow();
});
it("uses actual allocated language count; legacy bounds stay unchanged", () => {
  const one = allocateGenerationInputs([{ path: "one.md", bytes: 100 }], 2, 2);
  const nine = allocateGenerationInputs(
    Array.from({ length: 9 }, (_, i) => ({ path: i + ".md", bytes: 100 })),
    2,
    2,
  );
  expect(fallbackMaximum(one)).toBe(525330);
  expect(fallbackMaximum(nine)).toBe(1249533);
  expect(fallbackMaximum(one, 2)).toBeLessThan(525330);
  expect(fallbackMaximum(nine, 2)).toBeLessThan(1250000);
});

it("uses review 24000 output including thinking and a proper Chat payload without OpenAI credentials", async () => {
  const ai = vi.fn(async (_model, payload) => {
    expect(payload.max_completion_tokens).toBe(24000);
    expect(payload.input).toBeUndefined();
    return response();
  });
  const batch = vi.fn(async () => [
    { meta: { changes: 1 } },
    { meta: { changes: 1 } },
    { meta: { changes: 1 } },
  ]);
  const env = {
    AI: { run: ai },
    CMS_AI_DB: {
      prepare: () => ({
        bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }),
      }),
      batch,
    },
    CMS_AI_IMAGES: { put: async () => ({}) },
  } as unknown as AppEnv;
  const result = await seoTextResponse(env, {
    jobId: "00000000-0000-4000-8000-000000000001",
    runId: "seo-00000000-0000-4000-8000-000000000002",
    callId: "seo-00000000-0000-4000-8000-000000000003",
    articleKey: "wiki:test.md",
    deadline: now + 60000,
    phase: "review",
    budgetVersion: 2,
    reviewOutput: 2,
    request: {
      instructions: "review",
      input: "source",
      max_output_tokens: 24000,
      text: {
        format: {
          type: "json_schema",
          schema: request().response_format.json_schema,
        },
      },
    },
  });
  expect(result.status).toBe("completed");
  expect(ai).toHaveBeenCalledTimes(1);
  expect(batch).toHaveBeenCalledTimes(1);
});
it("holds the October 26 slot only until its original UTC start, without increasing a monthly limit", () => {
  expect(newJobMonthLimit("2026-10", now)).toBe(12350000);
  expect(newJobMonthLimit("2026-10", Date.parse("2026-10-26T00:00:00Z"))).toBe(
    13600000,
  );
  expect(newJobMonthLimit("2026-11", Date.parse("2026-11-01T00:00:00Z"))).toBe(
    7000000,
  );
});

it("new generation output reserves 48k at official output rate, caps deadline, and never retries length", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const payload = { ...request(), max_completion_tokens: 48000 };
  const ai = vi.fn(async () => ({
    ...response(),
    choices: [
      {
        finish_reason: "length",
        message: { role: "assistant", content: "incomplete" },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 48000 },
  }));
  const reserve = vi.fn(async () => {}),
    save = vi.fn(async () => {});
  await expect(
    runTextModel(
      { AI: { run: ai } } as unknown as AppEnv,
      SEO_DEEPSEEK,
      payload,
      reserve,
      now + 600000,
      true,
      save,
    ),
  ).rejects.toThrow();
  expect(timeout).toHaveBeenLastCalledWith(480000);
  expect(ai).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledTimes(1);
  expect(reserve).toHaveBeenCalledTimes(1);
  expect(
    deepseekUpperCost(deepseekPayload(payload)) -
      deepseekUpperCost(
        deepseekPayload({ ...payload, max_completion_tokens: 12000 }),
      ),
  ).toBe(43200);
  await expect(
    runTextModel(
      { AI: { run: ai } } as unknown as AppEnv,
      SEO_DEEPSEEK,
      payload,
      reserve,
      now + 20000,
      true,
    ),
  ).rejects.toThrow();
  expect(timeout).toHaveBeenLastCalledWith(20000);
});
it.each([
  [6000, 120000],
  [24000, 480000],
])(
  "bounds %i-token review wait without retry or budget changes",
  async (tokens, maximum) => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const payload = { ...request(), max_completion_tokens: tokens };
    const reserve = vi.fn(async (_model, actual) => {
      expect(actual).toEqual(deepseekPayload(payload));
      expect(deepseekUpperCost(actual)).toBe(
        deepseekUpperCost(deepseekPayload(payload)),
      );
    });
    const ai = vi.fn(async () => response());
    await runTextModel(
      { AI: { run: ai } } as unknown as AppEnv,
      SEO_DEEPSEEK,
      payload,
      reserve,
      now + 600000,
      true,
    );
    expect(timeout).toHaveBeenLastCalledWith(maximum);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(ai).toHaveBeenCalledTimes(1);
    ai.mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"));
    await expect(
      runTextModel(
        { AI: { run: ai } } as unknown as AppEnv,
        SEO_DEEPSEEK,
        payload,
        reserve,
        now + 20000,
        true,
      ),
    ).rejects.toThrow();
    expect(timeout).toHaveBeenLastCalledWith(20000);
    expect(ai).toHaveBeenCalledTimes(2);
  },
);
it("bounds all 1..9 locale v2 generations without changing the old job maximum", () => {
  for (let count = 1; count <= 9; count++) {
    const allocation = allocateGenerationInputs(
      Array.from({ length: count }, (_, i) => ({
        path: i + ".md",
        bytes: 100,
      })),
      2,
      2,
    );
    expect(
      fallbackMaximum(allocation, 2, 2) - fallbackMaximum(allocation, 2, 1),
    ).toBe(count * 43200);
    expect(fallbackMaximum(allocation, 2, 2)).toBeLessThanOrEqual(1250000);
  }
});
