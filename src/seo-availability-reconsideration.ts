import type { AppEnv } from "./env.ts";
import { proofObjects } from "./seo-proof-objects.ts";
import { verifyResearchReconsideration } from "./seo-research-focus.ts";
import { responseMessage } from "./seo-responses.ts";
import { assertRecoveryRetrieval } from "./seo-research-recovery.ts";

// A new bounded attempt, never a reinterpretation of the old insufficient result.
export async function verifyAvailabilityReconsideration(
  env: AppEnv,
  row: any,
  receipt: any,
  objects = proofObjects(env, Infinity),
) {
  if (
    row.research_focus !== 2 ||
    row.retrieval_fallback !== 1 ||
    !(await verifyResearchReconsideration(env, row, receipt, objects, 2))
  )
    return false;
  const read = async (key: string) => {
    const object = await objects.env.CMS_AI_IMAGES.get(key);
    if (!object) throw new Error("seo_availability_evidence");
    return JSON.parse(await object.text());
  };
  const discovery = await read(`seo-editorial/${row.id}/discovery.json`);
  if (
    discovery.version !== 5 ||
    typeof discovery.selectedUrl !== "string" ||
    discovery.fallbackUrl !== null
  )
    return false;
  const call = receipt.calls.find((c: any) => c.phase === "research");
  const response = await read(`seo-responses/${call.callId}.json`);
  const block = /\n```json\r?\n([\s\S]+?)\r?\n```\s*$/.exec(
    responseMessage(response).text,
  );
  if (!block) return false;
  const value = JSON.parse(block[1]);
  if (
    Object.keys(value).sort().join() !== "retrieval,sources,verdict" ||
    value.verdict !== "insufficient" ||
    !Array.isArray(value.sources) ||
    value.sources.length !== 0 ||
    !Array.isArray(value.retrieval) ||
    value.retrieval.length !== 1 ||
    value.retrieval[0]?.outcome !== "unavailable"
  )
    return false;
  const calls = (response.output || []).filter((x: any) =>
    x.type?.endsWith("_call"),
  );
  if (
    calls.length !== 1 ||
    calls[0].type !== "web_search_call" ||
    calls[0].status !== "completed"
  )
    return false;
  return (
    assertRecoveryRetrieval(value, calls, discovery) === discovery.selectedUrl
  );
}
