import { describe, it, expect } from "vitest";
import {
  allocateGenerationInputs,
  assertGenerationAllocation,
  GENERATION_INPUT_POOL,
  SPLIT_RESEARCH_RUN_MICROS,
  FULL_RESEARCH_RUN_MICROS,
  STAGE_INPUT_BYTES,
  stageBudget,
  assertStageInput,
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

it("bounds actual serialized payloads and each call rounding at 1205876 for budget v2", () => {
  function fill(request: any, bytes: number) {
    request.padding = "";
    request.padding = "x".repeat(
      bytes - Buffer.byteLength(JSON.stringify(request)),
    );
    expect(Buffer.byteLength(JSON.stringify(request))).toBe(bytes);
    return request;
  }
  const plan = fill(responseRequest("", {}, {}), stageBudget(2).limits.plan);
  const search = fill(
    { ...responseRequest("", {}, null, true), max_tool_calls: 1 },
    stageBudget(2).limits.research,
  );
  const review = fill(
    responseRequest("", {}, {}),
    stageBudget(2).limits.review,
  );
  const allocations = allocateGenerationInputs(
    Array.from({ length: 9 }, (_, i) => ({
      path: `p${i}`,
      bytes: 39000 + i * 500,
    })),
    2,
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
  expect(total).toBe(stageBudget(2).maximum);
  expect(total).toBe(1205876);
  const highSearch = fill(
    {
      ...search,
      tools: [
        {
          type: "web_search",
          search_context_size: "high",
          external_web_access: true,
        },
      ],
    },
    stageBudget(2).limits.research,
  );
  expect(responsesUpperCost(highSearch, now)).toBe(
    responsesUpperCost(search, now),
  );
  expect(total).toBeLessThan(1250000);
  expect(FULL_RESEARCH_RUN_MICROS).toBe(989075);
  expect(() =>
    responsesUpperCost({ ...search, max_tool_calls: 2 }, now),
  ).toThrow();
});

it("does not reinterpret old fixed allocations or loosen their per-stage caps", () => {
  const inputs = Array.from({ length: 9 }, (_, i) => ({
    path: `p${i}`,
    bytes: 40000,
  }));
  const old = allocateGenerationInputs(inputs, 1),
    current = allocateGenerationInputs(inputs, 2);
  expect(old.reduce((s, x) => s + x.maxBytes, 0)).toBe(405000);
  expect(current.reduce((s, x) => s + x.maxBytes, 0)).toBe(525000);
  expect(() => assertGenerationAllocation(old, 1)).not.toThrow();
  expect(() => assertGenerationAllocation(current, 2)).not.toThrow();
  expect(() => assertGenerationAllocation(old, 2)).toThrow();
  expect(() => assertGenerationAllocation(current, 1)).toThrow();
  const request = { text: "x".repeat(20000) };
  expect(() => assertStageInput("plan", request, 1)).toThrow();
  expect(() => assertStageInput("plan", request, 2)).not.toThrow();
  expect(() => stageBudget(3)).toThrow();
});
