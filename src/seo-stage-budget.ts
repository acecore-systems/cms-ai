// Limits apply to the final serialized provider request, not just article bytes.
export const STAGE_INPUT_BYTES = {
  plan: 16000,
  research: 16000,
  review: 180000,
  generation: 40000,
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
export const FULL_RESEARCH_RUN_MICROS =
  Math.ceil((16000 + 8192) * 0.3 + 6000) +
  Math.ceil((128000 + 16000 + 8192) * 4 * 0.3 + 30000 + 6000) +
  9 * (40000 + 8192 + 12000 * 2) +
  Math.ceil((180000 + 8192) * 0.3 + 6000);
