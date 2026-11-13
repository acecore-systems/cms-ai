import { loadSeoMuseEffort } from "./seo-muse-effort.ts";
import type { AppEnv } from "./env.ts";
import { callMeta, MUSE_MODEL } from "./meta.ts";
import {
  musePayload,
  museUpperCost,
  validateMuseResponse,
} from "./seo-muse.ts";
import { textSchema } from "./seo-text-schema.ts";
import { SeoBudget, sha256 } from "./seo-budget.ts";
import { assertStageInput } from "./seo-stage-budget.ts";
import { assertPlanOutputPreflight } from "./seo-plan-output.ts";
import { SEO_LONG_TEXT_MS } from "./seo-time-bounds.ts";

export async function seoMuseTextResponse(
  env: AppEnv,
  args: {
    runId: string;
    jobId: string;
    callId: string;
    articleKey: string;
    deadline: number;
    request: Record<string, unknown>;
    phase: "plan" | "review" | "discovery" | "research";
    modelVersion?: 4 | 5;
    budgetVersion?: number;
    recovery?: number;
    reviewOutput?: number;
  },
) {
  const budget = new SeoBudget(env.CMS_AI_DB);
  let reserved = false;
  try {
    const request = args.request;
    const schema = textSchema(request, true),
      payload = musePayload(
        request,
        true,
        await loadSeoMuseEffort(env, args.jobId, args.phase),
      );
    assertStageInput(
      args.phase === "discovery" ? "research" : args.phase,
      payload,
      args.budgetVersion,
      args.recovery,
      args.reviewOutput,
    );
    if (args.phase === "plan")
      await assertPlanOutputPreflight(
        env,
        args.jobId,
        args.runId,
        payload,
        args.modelVersion ?? 4,
      );
    const amount = museUpperCost(payload);
    const raw = await callMeta(
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
            model: MUSE_MODEL,
            modelVersion: args.modelVersion ?? 4,
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
    const text = validateMuseResponse(raw, payload, schema, args.deadline);
    const result = {
      adapterVersion: 1,
      provider: "meta",
      model: MUSE_MODEL,
      id: raw.id,
      status: "completed",
      usage: {
        input_tokens: raw.usage.prompt_tokens,
        output_tokens: raw.usage.completion_tokens,
      },
      output: [
        {
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
    };
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
