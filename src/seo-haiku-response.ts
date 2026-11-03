import type { AppEnv } from "./env.ts";
import { callAnthropic, HAIKU_MODEL } from "./anthropic.ts";
import {
  haikuPayload,
  haikuSchema,
  haikuUpperCost,
  normalizedHaiku,
  validateHaikuResponse,
} from "./seo-haiku.ts";
import { SeoBudget, sha256 } from "./seo-budget.ts";
import { assertStageInput } from "./seo-stage-budget.ts";
import { assertPlanOutputPreflight } from "./seo-plan-output.ts";
import { SEO_LONG_TEXT_MS } from "./seo-time-bounds.ts";

export async function seoHaikuTextResponse(
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
    const effort =
      args.phase === "review"
        ? await env.CMS_AI_DB.prepare(
            "SELECT version FROM seo_review_effort_contracts WHERE job_id=?",
          )
            .bind(args.jobId)
            .first<{ version: number }>()
        : null;
    const request = {
      ...args.request,
      reasoning_effort: effort?.version === 2 ? "low" : "high",
    };
    const schema = haikuSchema(request, true),
      payload = haikuPayload(request, true);
    assertStageInput(
      args.phase,
      payload,
      args.budgetVersion,
      args.recovery,
      args.reviewOutput,
    );
    if (args.phase === "plan")
      await assertPlanOutputPreflight(env, args.jobId, args.runId, payload, 3);
    const amount = haikuUpperCost(payload);
    const raw = await callAnthropic(
      env,
      payload,
      args.deadline,
      async () => {
        await budget.reserve(
          args.runId,
          args.callId,
          args.articleKey,
          await sha256(JSON.stringify(payload)),
          amount,
          Date.now(),
          args.deadline,
          args.budgetVersion,
          {
            jobId: args.jobId,
            phase: args.phase,
            model: HAIKU_MODEL,
            modelVersion: 3,
          },
        );
        reserved = true;
      },
      async (value) => {
        if (
          !(await env.CMS_AI_IMAGES.put(
            "seo-provider-responses/" + args.callId + ".json",
            JSON.stringify(value),
            { onlyIf: { etagDoesNotMatch: "*" } },
          ))
        )
          throw Error("seo_response_storage");
      },
      SEO_LONG_TEXT_MS,
    );
    const text = validateHaikuResponse(raw, payload, schema, args.deadline);
    const result = normalizedHaiku(raw, text);
    if (
      !(await env.CMS_AI_IMAGES.put(
        "seo-responses/" + args.callId + ".json",
        JSON.stringify(result),
        { onlyIf: { etagDoesNotMatch: "*" } },
      ))
    )
      throw Error("seo_response_storage");
    if (Date.now() >= args.deadline) throw Error("seo_deadline");
    await budget.finish(args.callId, "complete");
    return result;
  } catch {
    if (reserved)
      await budget.finish(args.callId, "unresolved").catch(() => {});
    throw Error("seo_research_call");
  }
}
