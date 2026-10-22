import type { AppEnv } from "./env.ts";
import { sha256 } from "./seo-hash.ts";
import { responseText } from "./seo-responses.ts";

const fail = (): never => {
  throw new Error("seo_review_rejection_unverified");
};
const key = (job: string, name: string) => `seo-editorial/${job}/${name}.json`;
async function read(env: AppEnv, path: string) {
  const object = await env.CMS_AI_IMAGES.get(path);
  if (!object) return fail();
  const raw = await object.text();
  return { raw, hash: await sha256(raw), value: JSON.parse(raw) };
}
export async function immutableReviewObject(
  env: AppEnv,
  path: string,
  value: unknown,
) {
  const raw = JSON.stringify(value),
    existing = await env.CMS_AI_IMAGES.get(path);
  if (existing) {
    if ((await existing.text()) !== raw) return fail();
  } else if (
    !(await env.CMS_AI_IMAGES.put(path, raw, {
      onlyIf: { etagDoesNotMatch: "*" },
    }))
  )
    return fail();
  const stored = await read(env, path);
  if (stored.raw !== raw) return fail();
  return stored.hash;
}
export async function prepareReviewRejection(env: AppEnv, job: any, run: any) {
  const split = job.retrieval_contract === 2;
  const expectedCalls = split ? 13 : 12;
  const table = split ? "seo_all_checks" : "seo_editorial_checks";
  const paths: string[] = JSON.parse(job.paths_json || "[]");
  if (
    job.research_contract !== 2 ||
    job.status !== "generated" ||
    job.next_step !== 9 ||
    paths.length !== 9 ||
    new Set(paths).size !== 9 ||
    job.generation_started !== 1 ||
    job.publication_started !== 0 ||
    run.status !== "pending" ||
    Date.now() >= run.deadline
  )
    return fail();
  const source = await read(env, key(job.id, "source"));
  const canonical = source.value.find((f: any) => f.path === job.article_path);
  if (
    !canonical ||
    (await sha256(canonical.content.replace(/\r\n/g, "\n"))) !==
      job.source_sha256
  )
    return fail();
  const final = await read(env, key(job.id, "review-input"));
  if (
    !Array.isArray(final.value) ||
    final.value.length !== 9 ||
    final.value.some(
      (f: any, i: number) =>
        f.path !== paths[i] || typeof f.content !== "string",
    )
  )
    return fail();
  const budgets = (
    await env.CMS_AI_DB.prepare(
      "SELECT b.*,r.article_key FROM seo_budget_calls b JOIN seo_budget_runs r ON r.id=b.run_id WHERE b.run_id=? ORDER BY b.id",
    )
      .bind(run.budget_run_id)
      .all<any>()
  ).results;
  if (
    budgets.length !== expectedCalls ||
    budgets.some(
      (b: any) =>
        b.status !== "complete" ||
        b.article_key !== job.site_id + ":" + job.article_path,
    )
  )
    return fail();
  const checks = (
    await env.CMS_AI_DB.prepare(
      `SELECT * FROM ${table} WHERE job_id=? ORDER BY CASE phase WHEN 'plan' THEN 0 WHEN 'discovery' THEN 1 WHEN 'research' THEN 2 ELSE 3 END`,
    )
      .bind(job.id)
      .all<any>()
  ).results;
  if (
    checks.length !== (split ? 4 : 3) ||
    checks.map((c: any) => c.phase).join() !==
      (split ? "plan,discovery,research,review" : "plan,research,review")
  )
    return fail();
  const calls: any[] = [],
    ids = new Set<string>();
  const files: any[] = [];
  for (const c of checks) {
    if (
      c.status !== (c.phase === "review" ? "unresolved" : "complete") ||
      !budgets.some((b: any) => b.id === c.call_id)
    )
      return fail();
    const manifest = await read(env, key(job.id, c.phase + "-call")),
      response = await read(env, `seo-responses/${c.call_id}.json`);
    if (
      manifest.value.callId !== c.call_id ||
      manifest.value.inputSha256 !== c.input_sha256 ||
      manifest.value.responseKey !== `seo-responses/${c.call_id}.json` ||
      response.value.status !== "completed" ||
      !Number.isSafeInteger(response.value.usage?.input_tokens) ||
      !Number.isSafeInteger(response.value.usage?.output_tokens)
    )
      return fail();
    if (c.phase === "review") {
      const f = await read(env, key(job.id, "review-failure")),
        v = responseText(response.value).value;
      if (
        (response.value.output || []).some(
          (x: any) => x.type === "web_search_call",
        ) ||
        c.input_sha256 !== final.hash ||
        f.value.callId !== c.call_id ||
        f.value.code !== "seo_ai_review_failed" ||
        f.value.responseStored !== true ||
        Object.keys(v).sort().join() !== "files,verdict" ||
        v.verdict !== "fail" ||
        !Array.isArray(v.files) ||
        v.files.length !== 9 ||
        new Set(v.files.map((x: any) => x.path)).size !== 9
      )
        return fail();
      if (
        v.files.some(
          (x: any) =>
            Object.keys(x).sort().join() !==
              "issues,meaningPreserved,naturalLanguage,path,referencesSupported" ||
            !paths.includes(x.path) ||
            [x.meaningPreserved, x.naturalLanguage, x.referencesSupported].some(
              (b) => typeof b !== "boolean",
            ) ||
            !Array.isArray(x.issues) ||
            x.issues.some((s: any) => typeof s !== "string" || !s.trim()),
        )
      )
        return fail();
      if (!v.files.some((x: any) => x.issues.length)) return fail();
      if (await env.CMS_AI_IMAGES.get(key(job.id, "review"))) return fail();
    } else {
      const result = await read(env, key(job.id, c.phase));
      if (result.hash !== c.result_sha256) return fail();
    }
    ids.add(c.call_id);
    calls.push({
      phase: c.phase,
      callId: c.call_id,
      responseSha256: response.hash,
      manifestSha256: manifest.hash,
      status: "completed",
    });
  }
  for (let i = 0; i < 9; i++) {
    const m = await read(env, key(job.id, `step-${i}-call`)),
      accepted = await read(env, key(job.id, `step-${i}`));
    const proposal = await read(env, `seo-proposals/${m.value.callId}.json`);
    if (
      ids.has(m.value.callId) ||
      !budgets.some((b: any) => b.id === m.value.callId) ||
      m.value.step !== i ||
      m.value.path !== paths[i] ||
      m.value.acceptedSha256 !== accepted.hash ||
      m.value.proposalSha256 !== proposal.hash ||
      accepted.value.path !== paths[i] ||
      !Array.isArray(proposal.value.changes) ||
      proposal.value.changes.length !== 1 ||
      proposal.value.changes[0].path !== paths[i]
    )
      return fail();
    ids.add(m.value.callId);
    calls.push({
      phase: "generation",
      callId: m.value.callId,
      responseSha256: proposal.hash,
      manifestSha256: m.hash,
      status: "completed",
    });
    files.push({
      path: paths[i],
      acceptedSha256: accepted.hash,
      finalSha256: await sha256(final.value[i].content),
    });
  }
  if (ids.size !== expectedCalls || !ids.has(job.call_id)) return fail();
  const offer = {
    version: split ? 2 : 1,
    runId: run.run_id,
    jobId: job.id,
    articleKey: job.article_key,
    sourceSha256: job.source_sha256,
    deadline: run.deadline,
    calls,
    files,
    filesSha256: final.hash,
    sourceBundleSha256: source.hash,
  };
  return immutableReviewObject(
    env,
    key(job.id, "review-rejection-offer"),
    offer,
  );
}
export async function reviewRejectionRow(env: AppEnv, jobId: string) {
  return env.CMS_AI_DB.prepare(
    "SELECT receipt_sha256,receipt_json FROM seo_review_rejections WHERE job_id=?",
  )
    .bind(jobId)
    .first<{ receipt_sha256: string; receipt_json: string }>();
}
export async function notifyReviewRejection(env: AppEnv, job: any) {
  const row = await reviewRejectionRow(env, job.id);
  if (!row) return null;
  if (job.callback_recorded) return true;
  const receipt = JSON.parse(row.receipt_json);
  const result = await (env.SEO_COORDINATOR as any).rejectReview({
    runId: receipt.runId,
    articleKey: receipt.articleKey,
    sourceSha256: receipt.sourceSha256,
    receiptSha256: row.receipt_sha256,
    receipt,
  });
  if (result.status !== "recorded") return false;
  await env.CMS_AI_DB.prepare(
    "UPDATE seo_editorial_jobs SET callback_recorded=1 WHERE id=?",
  )
    .bind(job.id)
    .run();
  return true;
}
export async function finalizeReviewRejection(
  env: AppEnv,
  job: any,
  run: any,
  body: any,
) {
  if (
    Object.keys(body).sort().join() !==
      "baseSha,offerSha256,pullRequests,refs" ||
    body.baseSha !== job.base_sha ||
    !Array.isArray(body.refs) ||
    body.refs.length ||
    !Array.isArray(body.pullRequests) ||
    body.pullRequests.length
  )
    return fail();
  const offer = await read(env, key(job.id, "review-rejection-offer"));
  if (offer.hash !== body.offerSha256) return fail();
  const existing = await reviewRejectionRow(env, job.id);
  const receipt = {
    ...offer.value,
    reason: "confirmed_review_rejection",
    researchContract: 2,
    generationCalls: 9,
    generationArtifacts: 9,
    publicationStarted: false,
    baseSha: job.base_sha,
    githubRunId: job.github_run_id,
    refs: [],
    pullRequests: [],
    decisionTime: existing
      ? JSON.parse(existing.receipt_json).decisionTime
      : Date.now(),
  };
  const raw = JSON.stringify(receipt),
    hash = await sha256(raw);
  if (existing) {
    if (existing.receipt_sha256 !== hash || existing.receipt_json !== raw)
      return fail();
  } else {
    if ((await prepareReviewRejection(env, job, run)) !== body.offerSha256)
      return fail();
    await immutableReviewObject(env, key(job.id, "review-rejection"), receipt);
    await env.CMS_AI_DB.prepare(
      "INSERT INTO seo_review_rejections(job_id,run_id,receipt_sha256,receipt_json,created_at) VALUES(?,?,?,?,?)",
    )
      .bind(job.id, run.run_id, hash, raw, Date.now())
      .run();
  }
  return {
    status: (await notifyReviewRejection(env, job))
      ? "review_rejected"
      : "unresolved",
    receiptSha256: hash,
  };
}
