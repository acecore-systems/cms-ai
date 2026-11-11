import type { AppEnv } from "./env.ts";
import { sha256 } from "./seo-hash.ts";
import { fallbackMaximum } from "./seo-fallback.ts";
import { SEO_PLAN_OUTPUT_TOKENS } from "./seo-deepseek.ts";

// Never reuse a pre-deployment 6k estimate for a 24k call. This is a read-only,
// pre-reservation fence; existing rows, reservations and completed checks stay intact.
export async function assertPlanOutputPreflight(
  env: AppEnv,
  jobId: string,
  budgetRunId: string,
  payload: Record<string, unknown>,
  modelVersion: 2 | 3 | 4 | 5 = 2,
) {
  const job = await env.CMS_AI_DB.prepare(
    "SELECT j.input_allocation_sha256,COALESCE(ve.generation_version,vg.version,mg.version,g.version,1) AS generation_output FROM seo_editorial_jobs j JOIN seo_editorial_runs r ON r.run_id=j.run_id LEFT JOIN seo_generation_contracts g ON g.job_id=j.id LEFT JOIN seo_muse_generation_contracts mg ON mg.job_id=j.id LEFT JOIN seo_v5_generation_contracts vg ON vg.job_id=j.id LEFT JOIN seo_v5_effort_contracts ve ON ve.job_id=j.id WHERE j.id=? AND r.budget_run_id=?",
  )
    .bind(jobId, budgetRunId)
    .first<{ input_allocation_sha256: string; generation_output: number }>();
  const saved = await env.CMS_AI_IMAGES.get(
    "seo-editorial/" + jobId + "/eligibility-preflight.json",
  );
  if (
    !job ||
    !saved ||
    (modelVersion === 3 || modelVersion === 4 || modelVersion === 5
      ? payload.max_tokens
      : payload.max_completion_tokens) !== SEO_PLAN_OUTPUT_TOKENS
  )
    throw Error("seo_plan_preflight_mismatch");
  const raw = await saved.text();
  if ((await sha256(raw)) !== job.input_allocation_sha256)
    throw Error("seo_plan_preflight_mismatch");
  const preflight = JSON.parse(raw);
  const maximum = fallbackMaximum(
    preflight.generationAllocation,
    modelVersion,
    job.generation_output,
  );
  if (
    preflight.modelVersion !== modelVersion ||
    preflight.modelMaximumMicros !== maximum ||
    preflight.planBytes !==
      new TextEncoder().encode(JSON.stringify(payload)).length ||
    (preflight.fallbackVersion === 1 && preflight.maximumMicros !== maximum)
  )
    throw Error("seo_plan_preflight_mismatch");
}
