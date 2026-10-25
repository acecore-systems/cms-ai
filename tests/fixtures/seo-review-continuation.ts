import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { sha256 } from "../../src/seo-hash.ts";
import { parsePlan } from "../../src/seo-research-plan.ts";
import { parseDiscovery } from "../../src/seo-discovery.ts";
import { externalScope } from "../../src/seo-external-sources.ts";
import { parseResearch, buildReviewRequest } from "../../src/seo-checks.ts";
import { sourceIdentity } from "../../src/seo-content.ts";
import {
  SEO_DEEPSEEK,
  deepseekPayload,
  deepseekUpperCost,
} from "../../src/seo-deepseek.ts";
import { format } from "prettier";
import { portalFormat } from "./seo-format.ts";

// Entirely synthetic; neither article content nor provider reasoning from an incident.
export async function continuationFixture(now: number) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=OFF");
  for (const file of readdirSync(new URL("../../migrations/", import.meta.url))
    .filter((n) => n.endsWith(".sql") && n >= "0004")
    .sort())
    db.exec(
      readFileSync(
        new URL("../../migrations/" + file, import.meta.url),
        "utf8",
      ),
    );
  const triggers = db
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'")
    .all();
  for (const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
  const oldRunId = "editorial-11111111-1111-4111-8111-111111111111",
    oldJobId = "22222222-2222-4222-8222-222222222222",
    budget = "seo-33333333-3333-4333-8333-333333333333";
  const path = "src/content/stories/synthetic.md",
    site = "aceserver-portal",
    articleKey = "portal:" + path,
    url = "https://docs.example.org/loader";
  const target =
    "ExampleEngine の glob ローダーが `**/*.md` パターンで再帰検出します。";
  const content =
    "---\ntitle: Synthetic\ndescription: Synthetic fixture\ndate: 2026-08-08T10:00:00+09:00\nlastUpdated: 2026-10-09T15:00:00+09:00\nauthor: fixture\n---\n\n" +
    target +
    "\n";
  const files = [
    { path, content },
    {
      path: "docs/writing.md",
      content: "# Synthetic guide\n原文の意味を保持する。\n",
    },
  ];
  const final = [
    {
      path,
      content: await format(
        content
          .replace("title: Synthetic", "title: Synthetic revised")
          .replace("2026-10-09T15:00:00+09:00", new Date(now).toISOString()) +
          "\n[Reference](" +
          url +
          ")\n",
        portalFormat,
      ),
    },
  ];
  const hash = await sha256(content),
    objects = new Map<string, string>();
  const key = (s: string) => `seo-editorial/${oldJobId}/${s}.json`;
  const put = (key: string, value: any) =>
    objects.set(key, JSON.stringify(value));
  const message = (text: string, annotations: any[] = []) => ({
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations }],
  });
  const response = (output: any[]) => ({
    id: "resp_synthetic",
    status: "completed",
    usage: { input_tokens: 100, output_tokens: 50 },
    output,
  });
  const pv = {
    verdict: "ready",
    claimId: "claim-1",
    targetQuote: target,
    conditions: [target],
    anchors: ["ExampleEngine"],
    queries: ["ExampleEngine glob official documentation"],
  };
  const plan = parsePlan(pv, content, hash, 2, 2),
    planResponse = response([message(JSON.stringify(pv))]);
  const search = response([
    {
      type: "web_search_call",
      status: "completed",
      action: {
        type: "search",
        queries: plan.queries,
        sources: [{ type: "url", url }],
      },
    },
    message(
      JSON.stringify({
        verdict: "selected",
        selectedUrl: url,
        fallbackUrl: null,
        reason: "Synthetic primary candidate",
      }),
    ),
  ]);
  const discovery = await parseDiscovery(
    search,
    content,
    plan,
    JSON.stringify(search),
    5,
    externalScope(site, files[0]),
    2,
  );
  const researchResponse = response([
    {
      type: "web_search_call",
      status: "completed",
      action: { type: "open_page", url },
    },
    message(
      "Synthetic verified source.\n```json\n" +
        JSON.stringify({
          verdict: "verified",
          retrieval: [{ url, outcome: "retrieved" }],
          sources: [
            {
              url,
              title: "Synthetic guide",
              claimId: "claim-1",
              excerpt:
                "Synthetic loader supports recursive glob patterns for markdown files.",
              assessment: "supports",
            },
          ],
        }) +
        "\n```",
      [{ type: "url_citation", url, start_index: 0, end_index: 9 }],
    ),
  ]);
  const evidence = parseResearch(
    researchResponse,
    content,
    hash,
    now - 600000,
    plan,
    discovery,
  );
  const finalHash = await sha256(JSON.stringify(final));
  const identity = sourceIdentity(
    "portal",
    "https://asv.acecore.net/stories/synthetic/",
    files,
    now,
    2,
  )!;
  const oldReviewPayload = deepseekPayload(
    buildReviewRequest(identity, files, final, evidence, 2, 2),
    true,
  );
  const oldReviewHash = await sha256(JSON.stringify(oldReviewPayload));
  const insert = (table: string, row: Record<string, any>) =>
    db
      .prepare(
        `INSERT INTO ${table} (${Object.keys(row).join()}) VALUES (${Object.keys(
          row,
        )
          .map(() => "?")
          .join()})`,
      )
      .run(...Object.values(row));
  const ids = Object.fromEntries(
    ["plan", "discovery", "research", "generation", "review"].map((p, i) => [
      p,
      `seo-44444444-4444-4444-8444-44444444444${i}`,
    ]),
  );
  insert("seo_editorial_runs", {
    run_id: oldRunId,
    budget_run_id: budget,
    input_sha256: "a".repeat(64),
    deadline: now - 1,
    candidates_json: JSON.stringify([
      {
        site: "portal",
        url: "https://asv.acecore.net/stories/synthetic/",
        reason: "Synthetic",
      },
    ]),
    status: "unresolved",
    job_id: oldJobId,
    article_key: articleKey,
    created_at: now - 900000,
  });
  insert("seo_editorial_jobs", {
    id: oldJobId,
    run_id: oldRunId,
    site_id: site,
    candidate_index: 0,
    status: "unresolved",
    github_run_id: "123",
    source_sha256: hash,
    base_sha: "a".repeat(40),
    article_key: articleKey,
    article_path: path,
    paths_json: JSON.stringify([path]),
    call_id: ids.generation,
    next_step: 1,
    claim_recorded: 1,
    callback_recorded: 1,
    generation_started: 1,
    publication_started: 0,
    protocol_version: 2,
    research_contract: 2,
    retrieval_contract: 2,
    research_recovery: 2,
    review_output: 2,
    budget_version: 2,
    reference_policy: 2,
    variable_review: 1,
    allocation_version: 2,
    generation_syntax: 2,
  });
  for (const table of [
    "seo_editorial_scope_contracts",
    "seo_plan_contracts",
    "seo_research_focus_contracts",
    "seo_retrieval_fallback_contracts",
  ])
    insert(table, { job_id: oldJobId, version: 2 });
  insert("seo_job_models", {
    job_id: oldJobId,
    version: 2,
    text_model: SEO_DEEPSEEK,
    search_model: "gpt-6-luna",
  });
  insert("seo_generation_contracts", {
    job_id: oldJobId,
    version: 2,
    max_completion_tokens: 48000,
    reasoning_effort: "high",
  });
  insert("seo_budget_runs", {
    id: budget,
    article_key: site + ":" + path,
    created_at: now - 900000,
    deadline: now - 1,
    run_limit_micros: 1250000,
  });
  put(key("source"), files);
  put(key("review-input"), final);
  put(key("step-0"), final[0]);
  const proposal = { changes: [final[0]] };
  put(`seo-proposals/${ids.generation}.json`, proposal);
  put(key("step-0-call"), {
    step: 0,
    path,
    callId: ids.generation,
    acceptedSha256: await sha256(JSON.stringify(final[0])),
    proposalSha256: await sha256(JSON.stringify(proposal)),
  });
  for (const phase of Object.keys(ids)) {
    insert("seo_model_calls", {
      call_id: ids[phase],
      job_id: oldJobId,
      phase,
      model: ["research", "discovery"].includes(phase)
        ? "gpt-6-luna"
        : SEO_DEEPSEEK,
      request_sha256: phase === "review" ? oldReviewHash : "b".repeat(64),
      budget_run_id: budget,
    });
    insert("seo_budget_calls", {
      id: ids[phase],
      run_id: budget,
      month_jst: "2026-10",
      request_sha256: phase === "review" ? oldReviewHash : "b".repeat(64),
      reserved_micros:
        phase === "review" ? deepseekUpperCost(oldReviewPayload) : 50000,
      status: phase === "review" ? "unresolved" : "complete",
      created_at: now - 500000,
    });
    if (phase === "generation") continue;
    const result = ({ plan, discovery, research: evidence } as any)[phase];
    if (result) {
      put(key(phase), result);
      put(
        `seo-responses/${ids[phase]}.json`,
        (
          {
            plan: planResponse,
            discovery: search,
            research: researchResponse,
          } as any
        )[phase],
      );
    }
    insert(
      phase === "discovery" ? "seo_discovery_checks" : "seo_editorial_checks",
      {
        job_id: oldJobId,
        phase,
        call_id: ids[phase],
        input_sha256: phase === "review" ? finalHash : "c".repeat(64),
        status: phase === "review" ? "unresolved" : "complete",
        result_sha256: result ? await sha256(JSON.stringify(result)) : null,
        created_at: now - 500000,
      },
    );
    put(key(phase + "-call"), {
      phase,
      callId: ids[phase],
      inputSha256: phase === "review" ? finalHash : "c".repeat(64),
      responseKey: `seo-responses/${ids[phase]}.json`,
      resultKey: key(phase),
      planCallKey: key("plan-call"),
    });
  }
  put(`seo-provider-responses/${ids.review}.json`, {
    model: SEO_DEEPSEEK,
    choices: [
      { finish_reason: "length", message: { role: "assistant", content: "" } },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 24000 },
  });
  put(key("review-failure"), {
    phase: "review",
    callId: ids.review,
    responseStored: false,
    code: "seo_check_failed",
    checkedAt: new Date(now - 500000).toISOString(),
  });
  for (const t of triggers) db.exec(String(t.sql));
  db.exec("PRAGMA foreign_keys=ON");
  const prepare = (q: string) => {
    const bound = (args: any[] = []) => ({
      bind: (...a: any[]) => bound(a),
      first: async () => db.prepare(q).get(...args) || null,
      all: async () => ({ results: db.prepare(q).all(...args) }),
      run: async () => ({
        meta: { changes: Number(db.prepare(q).run(...args).changes) },
      }),
    });
    return bound();
  };
  const env: any = {
    SEO_EDITORIAL_ENABLED: "true",
    SEO_GENERATION_ENABLED: "true",
    SEO_RESEARCH_ENABLED: "true",
    CMS_AI_DB: {
      prepare,
      batch: async (stmts: any[]) => {
        db.exec("BEGIN");
        try {
          const r = [];
          for (const s of stmts) r.push(await s.run());
          db.exec("COMMIT");
          return r;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    },
    CMS_AI_IMAGES: {
      get: async (k: string) =>
        objects.has(k)
          ? {
              text: async () => objects.get(k)!,
              json: async () => JSON.parse(objects.get(k)!),
            }
          : null,
      put: async (k: string, v: string) => {
        if (objects.has(k)) return null;
        objects.set(k, v);
        return {};
      },
    },
    SEO_COORDINATOR: {
      claim: async () => ({ status: "claimed" }),
      complete: async () => ({ status: "recorded" }),
    },
  };
  return {
    db,
    env,
    objects,
    oldRunId,
    oldJobId,
    key,
    files,
    final,
    ids,
    finalHash,
    articleKey,
  };
}
