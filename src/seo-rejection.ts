import { externalScope } from "./seo-external-sources.ts";
import { parseDiscovery, type Discovery } from "./seo-discovery.ts";
import type { AppEnv } from "./env.ts";
import { sha256 } from "./seo-hash.ts";
import { parsePlan, focusedInput } from "./seo-research-plan.ts";
import { parseResearch, type CheckContext } from "./seo-checks.ts";
import { responseText, responseMessage } from "./seo-responses.ts";
import { referenceUrl } from "./seo-evidence.ts";
const key = (job: string, suffix: string) =>
  `seo-editorial/${job}/${suffix}.json`;
const fail = () => {
  throw new Error("seo_rejection_unverified");
};
async function read(env: AppEnv, path: string) {
  const object = await env.CMS_AI_IMAGES.get(path);
  if (!object) return fail();
  const raw = await object.text();
  return { value: JSON.parse(raw), hash: await sha256(raw), raw };
}
export async function prepareRejection(
  env: AppEnv,
  context: CheckContext,
  source: string,
) {
  if (context.contractVersion !== 2) return fail();
  const scope =
    context.discoveryPolicy === 4
      ? externalScope(context.siteId!, {
          path: context.articleKey.slice(context.articleKey.indexOf(":") + 1),
          content: source,
        })
      : undefined;
  const split = context.retrievalVersion === 2;
  const table = split ? "seo_all_checks" : "seo_editorial_checks";
  const rows = (
    await env.CMS_AI_DB.prepare(
      `SELECT c.*,b.status AS budget_status FROM ${table} c JOIN seo_budget_calls b ON b.id=c.call_id WHERE c.job_id=? AND b.run_id=? ORDER BY CASE c.phase WHEN 'plan' THEN 0 WHEN 'discovery' THEN 1 WHEN 'research' THEN 2 ELSE 3 END`,
    )
      .bind(context.jobId, context.budgetRunId)
      .all<any>()
  ).results;
  if (
    !rows ||
    !(split ? [1, 2, 3] : [1, 2]).includes(rows.length) ||
    rows.some(
      (r: any, i: number) =>
        r.phase !==
        (split ? ["plan", "discovery", "research"] : ["plan", "research"])[i],
    )
  )
    return fail();
  let plan: any;
  let discovery: Discovery | undefined;
  const calls = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index],
      last = index === rows.length - 1;
    if (
      row.budget_status !== "complete" ||
      row.status !== (last ? "unresolved" : "complete")
    )
      return fail();
    const raw = await read(env, `seo-responses/${row.call_id}.json`);
    if (
      raw.value.status !== "completed" ||
      !Number.isSafeInteger(raw.value.usage?.input_tokens) ||
      !Number.isSafeInteger(raw.value.usage?.output_tokens)
    )
      return fail();
    const manifest = await read(env, key(context.jobId, row.phase + "-call"));
    if (
      manifest.value.callId !== row.call_id ||
      manifest.value.inputSha256 !== row.input_sha256 ||
      manifest.value.responseKey !== `seo-responses/${row.call_id}.json`
    )
      return fail();
    if (!last) {
      let parsed: any;
      if (row.phase === "plan") {
        plan = parsePlan(
          responseText(raw.value).value,
          source,
          context.sourceSha256,
          2,
        );
        focusedInput(source, context.sourceSha256, plan);
        parsed = plan;
      } else if (row.phase === "discovery" && plan) {
        const savedDiscovery = await read(env, key(context.jobId, row.phase));
        if (
          ![1, 2, 3, 4].includes(savedDiscovery.value.version) ||
          ((context.discoveryPolicy ?? 2) >= 3
            ? savedDiscovery.value.version !== context.discoveryPolicy
            : savedDiscovery.value.version >= 3)
        )
          return fail();
        discovery = await parseDiscovery(
          raw.value,
          source,
          plan,
          raw.raw,
          savedDiscovery.value.version,
          scope,
        );
        parsed = discovery;
      } else return fail();
      const saved = await read(env, key(context.jobId, row.phase));
      if (
        saved.hash !== row.result_sha256 ||
        JSON.stringify(saved.value) !== JSON.stringify(parsed)
      )
        return fail();
    } else {
      const failure = await read(
        env,
        key(context.jobId, row.phase + "-failure"),
      );
      if (
        failure.value.callId !== row.call_id ||
        failure.value.code !== "seo_research_insufficient" ||
        failure.value.responseStored !== true
      )
        return fail();
      if (row.phase === "plan") {
        if (
          (raw.value.output || []).some(
            (x: any) => x.type === "web_search_call",
          )
        )
          return fail();
        const v = responseText(raw.value).value;
        if (
          JSON.stringify(Object.keys(v).sort()) !==
            JSON.stringify([
              "anchors",
              "claimId",
              "conditions",
              "queries",
              "targetQuote",
              "verdict",
            ]) ||
          v.verdict !== "insufficient" ||
          v.claimId !== "" ||
          v.targetQuote !== "" ||
          [v.conditions, v.anchors, v.queries].some(
            (x) => !Array.isArray(x) || x.length,
          )
        )
          return fail();
      } else if (row.phase === "discovery") {
        if (!plan) return fail();
        try {
          await parseDiscovery(
            raw.value,
            source,
            plan,
            raw.raw,
            context.discoveryPolicy ?? 1,
            scope,
          );
          return fail();
        } catch (e) {
          if (
            !(e instanceof Error) ||
            e.message !== "seo_research_insufficient"
          )
            return fail();
        }
      } else {
        const text = responseMessage(raw.value).text,
          block = /\n```json\r?\n([\s\S]+?)\r?\n```\s*$/.exec(text);
        if (!block) return fail();
        const v = JSON.parse(block[1]);
        if (
          v.verdict !== "insufficient" ||
          !Array.isArray(v.sources) ||
          v.sources.length > 1
        )
          return fail();
        for (const s of v.sources) {
          if (
            Object.keys(s).sort().join() !==
              "assessment,claimId,excerpt,title,url" ||
            s.claimId !== plan.claimId ||
            !["supports", "contradicts", "unverified"].includes(s.assessment) ||
            typeof s.title !== "string" ||
            !s.title.length ||
            s.title.length > 300 ||
            typeof s.excerpt !== "string" ||
            s.excerpt.length < 20 ||
            s.excerpt.length > 800 ||
            source.includes(referenceUrl(s.url))
          )
            return fail();
        }
        try {
          parseResearch(
            raw.value,
            source,
            context.sourceSha256,
            Date.now(),
            plan,
            discovery,
          );
          return fail();
        } catch (e) {
          if (
            !(e instanceof Error) ||
            e.message !== "seo_research_insufficient"
          )
            return fail();
        }
      }
    }
    if (await env.CMS_AI_IMAGES.get("seo-proposals/" + row.call_id + ".json"))
      return fail();
    calls.push({
      phase: row.phase,
      callId: row.call_id,
      responseSha256: raw.hash,
      manifestSha256: manifest.hash,
      status: "completed",
      verdict: last ? "insufficient" : "ready",
    });
  }
  const offer = {
    version: split ? 2 : 1,
    runId: context.runId,
    jobId: context.jobId,
    articleKey: context.articleKey,
    sourceSha256: context.sourceSha256,
    deadline: context.deadline,
    calls,
  };
  const raw = JSON.stringify(offer),
    hash = await sha256(raw),
    path = key(context.jobId, "rejection-offer");
  const existing = await env.CMS_AI_IMAGES.get(path);
  if (existing) {
    if ((await existing.text()) !== raw) return fail();
  } else if (
    !(await env.CMS_AI_IMAGES.put(path, raw, {
      onlyIf: { etagDoesNotMatch: "*" },
    }))
  )
    return fail();
  return hash;
}
export async function rejectionRow(env: AppEnv, jobId: string) {
  return env.CMS_AI_DB.prepare(
    "SELECT receipt_sha256,receipt_json FROM seo_research_rejections WHERE job_id=?",
  )
    .bind(jobId)
    .first<{ receipt_sha256: string; receipt_json: string }>();
}
export async function notifyRejection(env: AppEnv, job: any) {
  const row = await rejectionRow(env, job.id);
  if (!row) return null;
  if (job.callback_recorded) return true;
  const receipt = JSON.parse(row.receipt_json);
  const result = await (env.SEO_COORDINATOR as any).rejectResearch({
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
export async function finalizeRejection(
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
  const offer = await read(env, key(job.id, "rejection-offer"));
  if (offer.hash !== body.offerSha256) return fail();
  const existing = await rejectionRow(env, job.id);
  const receipt = {
    ...offer.value,
    reason: "confirmed_insufficient",
    researchContract: 2,
    generationCalls: 0,
    generationArtifacts: 0,
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
    if (
      Date.now() >= run.deadline ||
      run.status !== "pending" ||
      job.status !== "claimed" ||
      job.research_contract !== 2 ||
      job.generation_started ||
      job.publication_started ||
      job.call_id ||
      job.next_step
    )
      return fail();
    if (
      (await env.CMS_AI_IMAGES.get(key(job.id, "step-0"))) ||
      (await env.CMS_AI_IMAGES.get(key(job.id, "research")))
    )
      return fail();
    // Revalidate every response and budget row immediately before the atomic insert.
    const source = await read(env, key(job.id, "source"));
    const canonical = source.value.find(
      (x: any) => x.path === job.article_path,
    );
    if (
      !canonical ||
      (await sha256(canonical.content.replace(/\r\n/g, "\n"))) !==
        job.source_sha256
    )
      return fail();
    if (
      (await prepareRejection(
        env,
        {
          jobId: job.id,
          runId: run.run_id,
          budgetRunId: run.budget_run_id,
          articleKey: job.article_key,
          budgetArticleKey: job.site_id + ":" + job.article_path,
          sourceSha256: job.source_sha256,
          deadline: run.deadline,
          contractVersion: 2,
          retrievalVersion: job.retrieval_contract,
          researchContext: job.research_context,
          discoveryPolicy: job.external_sources ? 4 : job.discovery_policy,
          ...(job.external_sources ? { siteId: job.site_id } : {}),
        },
        canonical.content,
      )) !== body.offerSha256
    )
      return fail();
    const path = key(job.id, "rejection");
    const stored = await env.CMS_AI_IMAGES.get(path);
    if (stored) {
      if ((await stored.text()) !== raw) return fail();
    } else if (
      !(await env.CMS_AI_IMAGES.put(path, raw, {
        onlyIf: { etagDoesNotMatch: "*" },
      }))
    )
      return fail();
    await env.CMS_AI_DB.prepare(
      "INSERT INTO seo_research_rejections(job_id,run_id,receipt_sha256,receipt_json,created_at) VALUES(?,?,?,?,?)",
    )
      .bind(job.id, run.run_id, hash, raw, Date.now())
      .run();
  }
  return {
    status: (await notifyRejection(env, job))
      ? "research_rejected"
      : "unresolved",
    receiptSha256: hash,
  };
}
