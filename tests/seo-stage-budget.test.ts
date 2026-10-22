import { describe, it, expect } from "vitest";
import {
  allocateGenerationInputs,
  assertGenerationAllocation,
  GENERATION_INPUT_POOL,
  SPLIT_RESEARCH_RUN_MICROS,
  FULL_RESEARCH_RUN_MICROS,
  STAGE_INPUT_BYTES,
} from "../src/seo-stage-budget.ts";
import { responseRequest, responsesUpperCost } from "../src/seo-responses.ts";
import { upperCost } from "../src/seo-budget.ts";
const now = Date.parse("2026-10-22T00:00:00Z");
it("allocates the entire fixed pool in canonical path order without reducing any original input", () => {
  const baseline = Array.from({ length: 9 }, (_, i) => ({
    path: `locale${i}.md`,
    bytes: 39000 + i * 500,
  }));
  const value = allocateGenerationInputs(baseline);
  expect(value.reduce((s, x) => s + x.maxBytes, 0)).toBe(GENERATION_INPUT_POOL);
  expect(
    value.every(
      (x, i) =>
        x.baselineBytes === baseline[i].bytes && x.maxBytes >= x.baselineBytes,
    ),
  ).toBe(true);
  expect(() => assertGenerationAllocation(value)).not.toThrow();
  const changed = structuredClone(value);
  changed[0].maxBytes++;
  expect(() => assertGenerationAllocation(changed)).toThrow();
  expect(() =>
    allocateGenerationInputs(baseline.map((x) => ({ ...x, bytes: 50000 }))),
  ).toThrow();
  expect(() =>
    allocateGenerationInputs([...baseline.slice(1), baseline[1]]),
  ).toThrow();
});
it("bounds actual serialized payloads and each call rounding at 985076, preserving the old contract", () => {
  function fill(request: any, bytes: number) {
    request.padding = "";
    request.padding = "x".repeat(
      bytes - Buffer.byteLength(JSON.stringify(request)),
    );
    expect(Buffer.byteLength(JSON.stringify(request))).toBe(bytes);
    return request;
  }
  const plan = fill(responseRequest("", {}, {}), STAGE_INPUT_BYTES.plan);
  const search = fill(
    { ...responseRequest("", {}, null, true), max_tool_calls: 1 },
    STAGE_INPUT_BYTES.research,
  );
  const review = fill(responseRequest("", {}, {}), STAGE_INPUT_BYTES.review);
  const allocations = allocateGenerationInputs(
    Array.from({ length: 9 }, (_, i) => ({
      path: `p${i}`,
      bytes: 39000 + i * 500,
    })),
  );
  const generation = allocations.reduce(
    (sum, x) =>
      sum +
      upperCost(
        "gpt-6-luna",
        fill(
          {
            service_tier: "default",
            max_completion_tokens: 12000,
            messages: [],
          },
          x.maxBytes,
        ),
        now,
      ),
    0,
  );
  const total =
    responsesUpperCost(plan, now) +
    2 * responsesUpperCost(search, now) +
    responsesUpperCost(review, now) +
    generation;
  expect(total).toBe(SPLIT_RESEARCH_RUN_MICROS);
  expect(total).toBe(985076);
  expect(total).toBeLessThan(1000000);
  expect(FULL_RESEARCH_RUN_MICROS).toBe(989075);
  expect(() =>
    responsesUpperCost({ ...search, max_tool_calls: 2 }, now),
  ).toThrow();
});
