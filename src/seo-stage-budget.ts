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
