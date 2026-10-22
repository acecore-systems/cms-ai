// Limits apply to the final serialized provider request, not just article bytes.
export const STAGE_INPUT_BYTES = {
  plan: 16000,
  research: 16000,
  review: 180000,
  generation: 45000,
} as const;
export function assertStageInput(
  stage: keyof typeof STAGE_INPUT_BYTES,
  request: unknown,
  version = 1,
) {
  if (
    new TextEncoder().encode(JSON.stringify(request)).length >
    stageBudget(version).limits[stage]
  )
    throw new Error("seo_stage_input_budget");
}
const limits = STAGE_INPUT_BYTES;
export const FULL_RESEARCH_RUN_MICROS =
  Math.ceil((limits.plan + 8192) * 0.3 + 6000) +
  Math.ceil((128000 + limits.research + 8192) * 4 * 0.3 + 30000 + 6000) +
  9 * (limits.generation + 8192 + 12000 * 2) +
  Math.ceil((limits.review + 8192) * 0.3 + 6000);

// New retrieval contract: two independent hosted calls, each limited to one
// tool invocation, with a separate reservation and at most two model passes.
export const SPLIT_RESEARCH_RUN_MICROS =
  Math.ceil((limits.plan + 8192) * 0.3 + 6000) +
  2 * Math.ceil((128000 + limits.research + 8192) * 2 * 0.3 + 10000 + 6000) +
  9 * (limits.generation + 8192 + 12000 * 2) +
  Math.ceil((limits.review + 8192) * 0.3 + 6000);
export const GENERATION_INPUT_POOL = 9 * limits.generation;

export function allocateGenerationInputs(
  inputs: { path: string; bytes: number }[],
  version = 1,
  allocationVersion = 1,
) {
  const count = inputs.length;
  if (
    ![1, 2].includes(allocationVersion) ||
    (allocationVersion === 1 ? count !== 9 : count < 1 || count > 9) ||
    new Set(inputs.map((x) => x.path)).size !== count ||
    inputs.some(
      (x) => !x.path || !Number.isSafeInteger(x.bytes) || x.bytes <= 0,
    )
  )
    throw new Error("seo_stage_allocation");
  const pool = Math.floor((stageBudget(version).pool * count) / 9);
  const used = inputs.reduce((total, x) => total + x.bytes, 0);
  if (used > pool) throw new Error("seo_stage_input_budget");
  const remaining = pool - used;
  // Stable path order; the remainder is assigned once at claim time. No future
  // step can borrow from an already used cap or reinterpret a persisted plan.
  return inputs.map((input, i) => ({
    path: input.path,
    baselineBytes: input.bytes,
    maxBytes:
      input.bytes +
      Math.floor(remaining / count) +
      (i < remaining % count ? 1 : 0),
  }));
}

export function assertGenerationAllocation(
  value: ReturnType<typeof allocateGenerationInputs>,
  version = 1,
  allocationVersion = 1,
) {
  if (
    JSON.stringify(
      allocateGenerationInputs(
        value.map((x) => ({ path: x.path, bytes: x.baselineBytes })),
        version,
        allocationVersion,
      ),
    ) !== JSON.stringify(value)
  )
    throw new Error("seo_stage_allocation");
}

export const CURRENT_BUDGET_VERSION = 2;
const CURRENT_LIMITS = {
  plan: 32000,
  research: 16000,
  review: 500000,
  generation: 45000,
} as const;
export const CURRENT_SPLIT_RUN_MICROS =
  Math.ceil((CURRENT_LIMITS.plan + 8192) * 0.3 + 6000) +
  2 *
    Math.ceil(
      (128000 + CURRENT_LIMITS.research + 8192) * 2 * 0.3 + 10000 + 6000,
    ) +
  525000 +
  9 * (8192 + 12000 * 2) +
  Math.ceil((CURRENT_LIMITS.review + 8192) * 0.3 + 6000);
export function stageBudget(version = 1) {
  if (version === 1)
    return {
      limits: STAGE_INPUT_BYTES,
      pool: GENERATION_INPUT_POOL,
      maximum: SPLIT_RESEARCH_RUN_MICROS,
      runMicros: 1000000,
    };
  if (version === 2)
    return {
      limits: CURRENT_LIMITS,
      pool: 525000,
      maximum: CURRENT_SPLIT_RUN_MICROS,
      runMicros: 1250000,
    };
  throw new Error("seo_budget_version");
}
