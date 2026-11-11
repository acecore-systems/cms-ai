import type { AppEnv } from "./env.ts";

export type SeoMusePhase =
  "discovery" | "research" | "plan" | "generation" | "review";
export type SeoMuseEffort = "low" | "medium" | "max";

// Version zero is the immutable legacy v4/v5 medium payload.
export function seoMuseEffort(
  version: 0 | 1,
  phase: SeoMusePhase,
): SeoMuseEffort {
  if (version === 0) return "medium";
  if (version !== 1) throw Error("seo_effort_contract");
  if (phase === "discovery") return "low";
  if (phase === "generation" || phase === "review") return "max";
  return "medium";
}

export async function loadSeoMuseEffort(
  env: AppEnv,
  jobId: string,
  phase: SeoMusePhase,
) {
  const row = await env.CMS_AI_DB.prepare(
    "SELECT version FROM seo_v5_effort_contracts WHERE job_id=?",
  )
    .bind(jobId)
    .first<{ version: number }>();
  if (row && row.version !== 1) throw Error("seo_effort_contract");
  return seoMuseEffort(row ? 1 : 0, phase);
}
