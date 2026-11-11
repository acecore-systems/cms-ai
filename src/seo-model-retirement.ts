// Retain the historical model identity only to reject retired contracts.
export const RETIRED_HAIKU_MODEL = "claude-haiku-5-5";
export function rejectRetiredSeoModel(version: number | undefined) {
  if (version === 3) throw new Error("seo_haiku_retired");
}
