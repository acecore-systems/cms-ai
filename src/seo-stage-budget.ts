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
) {
  if (
    new TextEncoder().encode(JSON.stringify(request)).length >
    STAGE_INPUT_BYTES[stage]
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
) {
  if (
    inputs.length !== 9 ||
    new Set(inputs.map((x) => x.path)).size !== 9 ||
    inputs.some(
      (x) => !x.path || !Number.isSafeInteger(x.bytes) || x.bytes <= 0,
    )
  )
    throw new Error("seo_stage_allocation");
  const used = inputs.reduce((total, x) => total + x.bytes, 0);
  if (used > GENERATION_INPUT_POOL) throw new Error("seo_stage_input_budget");
  const remaining = GENERATION_INPUT_POOL - used;
  // Stable path order; the remainder is assigned once at claim time. No future
  // step can borrow from an already used cap or reinterpret a persisted plan.
  return inputs.map((input, i) => ({
    path: input.path,
    baselineBytes: input.bytes,
    maxBytes:
      input.bytes + Math.floor(remaining / 9) + (i < remaining % 9 ? 1 : 0),
  }));
}

export function assertGenerationAllocation(
  value: ReturnType<typeof allocateGenerationInputs>,
) {
  if (
    JSON.stringify(
      allocateGenerationInputs(
        value.map((x) => ({ path: x.path, bytes: x.baselineBytes })),
      ),
    ) !== JSON.stringify(value)
  )
    throw new Error("seo_stage_allocation");
}
