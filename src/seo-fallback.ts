import type { AppEnv } from "./env.ts";
import { seoArticleUrl } from "./sites.ts";
import { assertGenerationAllocation, stageBudget } from "./seo-stage-budget.ts";
import { monthBudgetMicros, jstMonth } from "./seo-budget.ts";

export type TrialAttempt = {
  version: 1;
  rootRunId: string;
  ordinal: number;
  previousReceiptSha256: string | null;
};
export function parseTrial(
  value: unknown,
  runId: string,
  candidate: { site: string; url: string },
) {
  const v = value as TrialAttempt;
  const target = seoArticleUrl(candidate.site, candidate.url);
  if (
    !v ||
    Object.keys(v).sort().join() !==
      "ordinal,previousReceiptSha256,rootRunId,version" ||
    v.version !== 1 ||
    !Number.isInteger(v.ordinal) ||
    v.ordinal < 1 ||
    v.ordinal > 3 ||
    !target ||
    !/^(?:weekly-\d{4}-\d{2}-\d{2}|editorial-[0-9a-f-]{36})$/.test(
      v.rootRunId,
    ) ||
    (v.ordinal === 1
      ? v.rootRunId !== runId || v.previousReceiptSha256 !== null
      : v.rootRunId === runId ||
        typeof v.previousReceiptSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(v.previousReceiptSha256))
  )
    throw Error("seo_fallback_input");
  return {
    ...v,
    candidateKey: `${target.spec.key}:${target.directory}:${target.slug}`,
  };
}
export function trialStatements(
  env: AppEnv,
  trial: ReturnType<typeof parseTrial>,
  runId: string,
  budgetRunId: string,
  now: number,
  deadline: number,
) {
  return [
    ...(trial.ordinal === 1
      ? [
          env.CMS_AI_DB.prepare(
            "INSERT INTO seo_fallback_trials(root_run_id,version,created_at,deadline) VALUES(?,1,?,?)",
          ).bind(trial.rootRunId, now, deadline),
        ]
      : []),
    env.CMS_AI_DB.prepare(
      "INSERT INTO seo_fallback_attempts(run_id,root_run_id,ordinal,budget_run_id,candidate_key,previous_receipt_sha256,created_at) VALUES(?,?,?,?,?,?,?)",
    ).bind(
      runId,
      trial.rootRunId,
      trial.ordinal,
      budgetRunId,
      trial.candidateKey,
      trial.previousReceiptSha256,
      now,
    ),
  ];
}

// New coordinator only. These are enforced allocated maxima, never expected usage.
export function fallbackMaximum(
  allocation: Parameters<typeof assertGenerationAllocation>[0],
  modelVersion = 1,
  generationOutput = 1,
) {
  if (
    ![1, 2].includes(generationOutput) ||
    (generationOutput === 2 && modelVersion !== 2)
  )
    throw Error("seo_generation_contract");
  assertGenerationAllocation(allocation, 2, 2);
  let maximum =
    stageBudget(2, 2, 2).maximum -
    stageBudget(2).pool +
    allocation.reduce((n, a) => n + a.maxBytes, 0) -
    (9 - allocation.length) * (8192 + 12000 * 2);
  if (modelVersion === 2) {
    const cost = (input: number, output: number) =>
      Math.ceil(((input + 8192) * 3 + output * 12) / 10);
    // Hosted search caps unchanged; replace only the three text stages.
    maximum =
      maximum -
      allocation.reduce((n, a) => n + a.maxBytes + 8192 + 12000 * 2, 0) -
      Math.ceil((32000 + 8192) * 0.3 + 6000) -
      Math.ceil((440000 + 8192) * 0.3 + 24000) +
      allocation.reduce(
        (n, a) => n + cost(a.maxBytes, generationOutput === 2 ? 48000 : 12000),
        0,
      ) +
      cost(32000, 6000) +
      cost(440000, 24000);
  }
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1250000)
    throw Error("seo_fallback_budget");
  return maximum;
}
export async function fallbackPreflight(
  env: AppEnv,
  runId: string,
  allocation: Parameters<typeof fallbackMaximum>[0] | undefined,
  modelVersion = 1,
  generationOutput = 1,
) {
  const group = await env.CMS_AI_DB.prepare(
    `SELECT t.deadline,
    (SELECT COALESCE(SUM(b.reserved_micros),0) FROM seo_budget_calls b JOIN seo_fallback_attempts x ON x.budget_run_id=b.run_id WHERE x.root_run_id=t.root_run_id) AS held
    FROM seo_fallback_attempts a JOIN seo_fallback_trials t USING(root_run_id) WHERE a.run_id=?`,
  )
    .bind(runId)
    .first<{ deadline: number; held: number }>();
  if (!group) return null;
  if (!allocation || group.deadline <= Date.now())
    throw Error("seo_fallback_preflight");
  const maximum = fallbackMaximum(allocation, modelVersion, generationOutput);
  return { maximum, held: group.held, fits: maximum + group.held <= 1250000 };
}
export async function fallbackTotals(env: AppEnv, rootRunId: string) {
  const row = await env.CMS_AI_DB.prepare(
    `SELECT t.deadline,
    (SELECT run_id FROM seo_fallback_attempts WHERE root_run_id=t.root_run_id ORDER BY ordinal DESC LIMIT 1) AS last_run_id,
    (SELECT COUNT(*) FROM seo_fallback_attempts WHERE root_run_id=t.root_run_id) AS attempt_count,
    (SELECT COALESCE(SUM(b.reserved_micros),0) FROM seo_budget_calls b JOIN seo_fallback_attempts a ON a.budget_run_id=b.run_id WHERE a.root_run_id=t.root_run_id) AS held,
    (SELECT COALESCE(SUM(reserved_micros),0) FROM seo_budget_calls WHERE month_jst=?) AS month_held
    FROM seo_fallback_trials t WHERE t.root_run_id=?`,
  )
    .bind(jstMonth(Date.now()), rootRunId)
    .first<{
      deadline: number;
      last_run_id: string;
      attempt_count: number;
      held: number;
      month_held: number;
    }>();
  return row
    ? { ...row, monthLimit: monthBudgetMicros(jstMonth(Date.now())) }
    : null;
}
