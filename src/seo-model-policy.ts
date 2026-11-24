import type { AppEnv } from "./env.ts";
import { readRegistryMetaSelection } from "./cms-model.ts";
import { MUSE_MODEL } from "./meta.ts";

// This is the compatibility boundary of the v5 Muse adapter and reservation contract.
export function selectSeoEditorialModel() {
  const selection = readRegistryMetaSelection("seo.editorial");
  if (selection.model !== MUSE_MODEL) throw Error("seo_model_not_allowed");
  return selection;
}

export async function loadSeoV5TextModel(env: AppEnv, jobId: string) {
  const row = await env.CMS_AI_DB.prepare(
    "SELECT text_model FROM seo_v5_job_models WHERE job_id=? AND version=5 AND search_model='parallel-free'",
  )
    .bind(jobId)
    .first<{ text_model: string }>();
  if (row?.text_model !== MUSE_MODEL) throw Error("seo_model_not_allowed");
  return row.text_model;
}
