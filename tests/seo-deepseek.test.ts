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
it("retired v2 cannot reserve or call DeepSeek", async () => {
  const ai = vi.fn(),
    reserve = vi.fn();
  await expect(
    runTextModel(
      { AI: { run: ai } } as unknown as AppEnv,
      SEO_DEEPSEEK,
      request(),
      reserve,
      now + 60000,
      true,
    ),
  ).rejects.toThrow("seo_deepseek_retired");
  expect(ai).not.toHaveBeenCalled();
  expect(reserve).not.toHaveBeenCalled();
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

it("holds the October 26 slot only until its original UTC start, without increasing a monthly limit", () => {
  expect(newJobMonthLimit("2026-10", now)).toBe(13350000);
  expect(newJobMonthLimit("2026-10", Date.parse("2026-10-26T00:00:00Z"))).toBe(
    14600000,
  );
  expect(newJobMonthLimit("2026-11", Date.parse("2026-11-01T00:00:00Z"))).toBe(
    7000000,
  );
});

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
