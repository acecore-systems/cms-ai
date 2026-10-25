import { assertPlanOutputPreflight } from "./seo-plan-output.ts";
import type { AppEnv } from "./env.ts";
import { runTextModel } from "./inference.ts";
import { SeoBudget, sha256 } from "./seo-budget.ts";
import { assertStageInput } from "./seo-stage-budget.ts";
import {
  SEO_DEEPSEEK,
  deepseekPayload,
  deepseekUpperCost,
  normalizedDeepseek,
} from "./seo-deepseek.ts";

export async function seoTextResponse(
  env: AppEnv,
  args: {
    runId: string;
    jobId: string;
    callId: string;
    articleKey: string;
    deadline: number;
    request: Record<string, unknown>;
    phase: "plan" | "review";
    budgetVersion?: number;
    recovery?: number;
    reviewOutput?: number;
  },
) {
  const budget = new SeoBudget(env.CMS_AI_DB);
  let reserved = false;
  try {
    const payload = deepseekPayload(args.request, true);
    assertStageInput(
      args.phase,
      payload,
      args.budgetVersion,
      args.recovery,
      args.reviewOutput,
    );
    if (args.phase === "plan")
      await assertPlanOutputPreflight(env, args.jobId, args.runId, payload);
    const raw = await runTextModel(
      env,
      SEO_DEEPSEEK,
      payload,
      async (model, actual) => {
        await budget.reserve(
          args.runId,
          args.callId,
          args.articleKey,
          await sha256(JSON.stringify(actual)),
          deepseekUpperCost(actual),
          Date.now(),
          args.deadline,
          args.budgetVersion,
          { jobId: args.jobId, phase: args.phase, model },
        );
        reserved = true;
      },
      args.deadline,
      true,
      async (raw) => {
        if (
          !(await env.CMS_AI_IMAGES.put(
            "seo-provider-responses/" + args.callId + ".json",
            JSON.stringify(raw),
            { onlyIf: { etagDoesNotMatch: "*" } },
          ))
        )
          throw Error("seo_research_storage");
      },
    );
    const result = normalizedDeepseek(raw);
    if (
      !(await env.CMS_AI_IMAGES.put(
        "seo-responses/" + args.callId + ".json",
        JSON.stringify(result),
        { onlyIf: { etagDoesNotMatch: "*" } },
      ))
    )
      throw Error("seo_research_storage");
    if (Date.now() >= args.deadline) throw Error("seo_deadline");
    await budget.finish(args.callId, "complete");
    return result;
  } catch {
    if (reserved)
      await budget.finish(args.callId, "unresolved").catch(() => {});
    throw Error("seo_research_call");
  }
}
