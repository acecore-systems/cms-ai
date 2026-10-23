import { prepareEditorialTransport } from "../src/seo-metadata-preservation.ts";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env.ts";
import { SITES, seoSite, SEO_LOCALES } from "../src/sites.ts";
import {
  startEditorial,
  editorialStatus,
  handleSeoRunnerRequest,
} from "../src/seo-editorial.ts";
import { buildEditorialInstruction } from "../src/seo-editorial-instruction.ts";
import { sha256 } from "../src/seo-hash.ts";
import { assertEditorialFiles, sourceIdentity } from "../src/seo-content.ts";
import { format } from "prettier";
import { articleBody, portalFormat } from "./fixtures/seo-format.ts";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  identity: null as unknown,
  infer: vi.fn(),
}));
vi.mock("../src/github.ts", () => ({
  dispatchSeoEditorialJob: mocks.dispatch,
}));
vi.mock("../src/oidc.ts", () => ({
  authenticateRunner: async () => mocks.identity,
}));
vi.mock("../src/inference.ts", async (original) => ({
  ...(await original()),
  runInference: (...args: unknown[]) => mocks.infer(...args),
}));
const now = Date.parse("2026-10-20T00:00:00Z");
const runId = "editorial-00000000-0000-4000-8000-000000000001";
const baseSha = "a".repeat(40);
const sourcePath = "src/content/stories/example.md";
const candidate = {
  site: "portal",
  url: "https://asv.acecore.net/en/stories/example/",
  reason: "既存本文の改善",
};
let sql: DatabaseSync,
  env: AppEnv,
  objects: Map<string, string>,
  files: { path: string; content: string }[],
  clock: ReturnType<typeof vi.spyOn>;
let legacyReview = false;
let legacyMetadata = false;
let claim: ReturnType<typeof vi.fn>, complete: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.clearAllMocks();
  legacyReview = false;
  legacyMetadata = false;
  clock = vi.spyOn(Date, "now").mockReturnValue(now);
  sql = new DatabaseSync(":memory:");
  for (const migration of [
    "0004_seo_budget.sql",
    "0005_seo_editorial.sql",
    "0006_seo_research.sql",
    "0007_seo_research_plan.sql",
    "0008_seo_rejection.sql",
    "0009_seo_review_rejection.sql",
    "0010_seo_discovery.sql",
    "0011_seo_month_budget.sql",
    "0012_seo_run_budget.sql",
    "0013_seo_discovery_policy.sql",
    "0014_seo_generation_syntax.sql",
    "0015_seo_october_budget.sql",
    "0016_seo_external_sources.sql",
    "0017_seo_research_context.sql",
    "0018_seo_allocation_cardinality.sql",
    "0019_seo_variable_review.sql",
    "0020_seo_reference_policy.sql",
    "0021_seo_url_instructions.sql",
    "0022_seo_research_recovery.sql",
    "0023_seo_discovery_instructions.sql",
    "0024_seo_code_preservation.sql",
    "0025_seo_review_output.sql",
    "0026_seo_metadata_preservation.sql",
    "0027_seo_october_budget_extension.sql",
    "0029_seo_october_budget_1114.sql",
    "0028_seo_code_token_repair.sql",
  ])
    sql.exec(
      readFileSync(
        new URL("../migrations/" + migration, import.meta.url),
        "utf8",
      ),
    );
  const prepare = (query: string) => {
    const bound = (args: unknown[] = []) => ({
      query,
      args,
      bind: (...values: unknown[]) => bound(values),
      run: async () => ({
        meta: {
          changes: Number(sql.prepare(query).run(...(args as [])).changes),
        },
      }),
      first: async () => sql.prepare(query).get(...(args as [])) || null,
      all: async () => ({ results: sql.prepare(query).all(...(args as [])) }),
    });
    return bound();
  };
  objects = new Map();
  claim = vi.fn(async () => ({ status: "claimed" }));
  complete = vi.fn(async () => ({ status: "recorded" }));
  env = {
    SEO_EDITORIAL_ENABLED: "true",
    SEO_GENERATION_ENABLED: "true",
    CMS_AI_MODEL: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
    SEO_AI_MODEL: "gpt-6-luna",
    CMS_AI_DB: {
      prepare,
      batch: async (statements: { query: string; args: unknown[] }[]) => {
        sql.exec("BEGIN");
        try {
          if (legacyReview)
            for (const item of statements) {
              if (item.query.startsWith("INSERT INTO seo_editorial_jobs"))
                item.args[item.args.length - 11] = 0;
            }
          if (legacyMetadata)
            for (const item of statements) {
              if (item.query.startsWith("INSERT INTO seo_editorial_jobs"))
                item.args[item.args.length - 4] = 1;
            }
          const values = statements.map((item) => ({
            meta: {
              changes: Number(
                sql.prepare(item.query).run(...(item.args as [])).changes,
              ),
            },
          }));
          sql.exec("COMMIT");
          return values;
        } catch (error) {
          sql.exec("ROLLBACK");
          throw error;
        }
      },
    },
    SEO_COORDINATOR: { claim, complete },
    CMS_AI_IMAGES: {
      put: async (
        key: string,
        value: string,
        options?: { onlyIf?: unknown },
      ) => {
        if (options?.onlyIf && objects.has(key)) return null;
        objects.set(key, value);
        return {};
      },
      get: async (key: string) =>
        objects.has(key)
          ? {
              json: async () => JSON.parse(objects.get(key)!),
              text: async () => objects.get(key)!,
            }
          : null,
    },
  } as unknown as AppEnv;
  mocks.dispatch.mockResolvedValue(undefined);
  mocks.identity = {
    site: seoSite("portal")!.site,
    repository: seoSite("portal")!.site.repository,
    runId: "100",
    workflowSha: baseSha,
  };
  const source =
    "---\ntitle: Original ja\ndescription: Original description\ndate: 2026-08-08T10:00:00+09:00\nauthor: Gui\nimage: /uploads/story.webp\nlastUpdated: 2026-10-09T15:00:00+09:00\n---\n\nOriginal body with [reference](https://example.org/guide).\n";
  files = [
    { path: sourcePath, content: source },
    ...(await Promise.all(
      SEO_LOCALES.map(async (locale) => ({
        path: "src/content/stories/" + locale + "/example.md",
        content: source
          .replace("title: Original ja", "title: Original " + locale)
          .replace(
            "description: Original description",
            "translationOf: example\nsourceHash: sha256:" +
              (await sha256(source)) +
              "\ndescription: Original description",
          ),
      })),
    )),
  ];
  mocks.infer.mockImplementation(
    async (
      _env,
      _site,
      job,
      context,
      _history,
      _feedback,
      beforeRequest,
      deadline,
    ) => {
      expect(deadline).toBe(now + 20 * 60_000);
      const path = JSON.parse(
        /変更は次の許可pathだけ: (\[[^\n]*\])/.exec(job.instruction)![1],
      )[0];
      await beforeRequest("gpt-6-luna", {
        max_completion_tokens: 12000,
        service_tier: "default",
        messages: [{ role: "user", content: "bounded" }],
      });
      return {
        changes: [
          {
            path,
            content: context
              .find((f: { path: string }) => f.path === path)
              .content.replaceAll("Original", "Revised"),
            reason: "copy",
          },
        ],
        summary: "改訂案",
        clarification: null,
      };
    },
  );
});
afterEach(() => {
  sql.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const start = (candidates: unknown[] = [candidate]) =>
  startEditorial(env, { runId, deadline: now + 20 * 60_000, candidates });
const row = () =>
  sql.prepare("SELECT * FROM seo_editorial_runs WHERE run_id=?").get(runId)!;
async function request(jobId: string, operation = "", body?: unknown) {
  const response = await handleSeoRunnerRequest(
    new Request(
      "https://cms-ai.acecore.net/seo-runner/jobs/" +
        jobId +
        (operation ? "/" + operation : ""),
      {
        method: operation ? "POST" : "GET",
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { "Content-Type": "application/json" },
            }),
      },
    ),
    env,
  );
  return response.json() as Promise<Record<string, any>>;
}
async function inspecting() {
  const result = await start();
  const jobId = result.jobId!;
  expect(
    sql
      .prepare(
        "SELECT discovery_instructions FROM seo_editorial_jobs WHERE id=?",
      )
      .get(jobId)!.discovery_instructions,
  ).toBe(2);
  await request(jobId);
  return jobId;
}
async function claimed() {
  const jobId = await inspecting();
  expect((await request(jobId, "claim", { baseSha, files })).status).toBe(
    "claimed",
  );
  return jobId;
}

describe("SEO durable editorial boundary", () => {
  it.each(["valid", "foreign", "abbreviated"])(
    "version2 pt transport %s preserves the raw proposal and original locale code",
    async (variant) => {
      for (const file of files)
        file.content +=
          "\n\n```ts\nconst message = " +
          JSON.stringify(file.path.includes("/pt/") ? "Português" : "日本語") +
          ";\n```\n";
      const jobId = await claimed();
      expect(
        sql
          .prepare(
            "SELECT code_preservation FROM seo_editorial_jobs WHERE id=?",
          )
          .get(jobId)!.code_preservation,
      ).toBe(2);
      let japanese = "";
      for (let step = 0; step <= 4; step++) {
        if (step === 4 && variant !== "valid") {
          const infer = mocks.infer.getMockImplementation()!;
          mocks.infer.mockImplementationOnce(async (...args) => {
            const result = await infer(...args);
            result.changes[0].content = result.changes[0].content.replace(
              "CMS_SEO_CODE_V1_F1_B0",
              variant === "foreign"
                ? "CMS_SEO_CODE_V1_F0_B0"
                : "CMS_SEO_CODE_V1_B0",
            );
            return result;
          });
        }
        const result = await request(jobId, "propose", {
          step,
          ...(step === 1 ? { japanese } : {}),
        });
        if (step === 4 && variant === "foreign") {
          expect(result.status).toBe("unresolved");
          expect(
            JSON.parse(objects.get("seo-editorial/" + jobId + "/failure.json")!)
              .code,
          ).toBe("seo_code_transport");
          expect(objects.has("seo-editorial/" + jobId + "/step-4.json")).toBe(
            false,
          );
        } else {
          expect(result.status).toBe("proposal_created");
          expect(result.file.content).not.toContain("CMS_SEO_CODE_V1_");
          if (step === 0) japanese = result.file.content;
          if (step === 4)
            expect(result.file.content).toContain(
              'const message = "Português";',
            );
        }
      }
      expect(mocks.infer).toHaveBeenCalledTimes(5);
      expect(
        sql
          .prepare(
            "SELECT COUNT(*) n FROM seo_budget_calls WHERE status='complete'",
          )
          .get()!.n,
      ).toBe(5);
      const raw = [...objects.entries()]
        .filter(([key]) => key.startsWith("seo-proposals/"))
        .at(-1)![1];
      expect(raw).toContain("CMS_SEO_CODE_V1_");
      if (variant === "abbreviated")
        expect(raw).toContain("CMS_SEO_CODE_V1_B0");
    },
  );

  it.each([
    "valid",
    "wiki-pass",
    "wiki-valid",
    "wiki-lost-callback",
    "wiki-missing-manifest",
    "wiki-budget-unknown",
    "wiki-source-changed",
    "legacy-valid",
    "missing-manifest",
    "budget-unknown",
    "source-changed",
    "publication",
    "lost-callback",
    "late",
    "bad-offer",
    "pr-exists",
    "malformed-review",
    "receipt-store-failure",
  ])("review rejection receipt: %s", async (variant) => {
    const wiki = variant.startsWith("wiki-");
    if (variant === "legacy-valid") {
      legacyReview = true;
      variant = "valid";
    }
    if (wiki && variant !== "wiki-pass") variant = variant.slice(5);
    env.SEO_RESEARCH_ENABLED = "true";
    env.OPENAI_API_KEY_STORE = { get: async () => "fixture-secret" };
    if (wiki) {
      files = [
        {
          path: "poc/astro-sveltia/src/content/wiki/example.md",
          content: files[0].content,
        },
      ];
      mocks.identity = {
        site: seoSite("wiki")!.site,
        repository: seoSite("wiki")!.site.repository,
        runId: "100",
        workflowSha: baseSha,
      };
    }
    const reference = "https://docs.example.org/new-guide";
    const infer = mocks.infer.getMockImplementation()!;
    mocks.infer.mockImplementation(async (...args) => {
      const result = await infer(...args);
      result.changes[0].content += "\n[Reference](" + reference + ")\n";
      return result;
    });
    const fetchMock = vi.fn(async (_url, options) => {
      const payload = JSON.parse(options.body);
      const input = JSON.parse(payload.input);
      if (payload.tools)
        expect(payload.tools[0].search_context_size).toBe(
          input.discovery ? "high" : "low",
        );
      const research = !!payload.tools;
      const value = input.claims
        ? {
            verdict: "ready",
            claimId: input.claims[0].id,
            targetQuote: input.claims[0].contextParts.find(
              (p: any) => p.selectable,
            ).quote,
            conditions: [
              input.claims[0].contextParts.find((p: any) => p.selectable).quote,
            ],
            anchors: ["Original"],
            queries: ["Original article guide"],
          }
        : research
          ? {
              verdict: "verified",
              sources: [
                {
                  url: reference,
                  title: "Guide",
                  claimId: "claim-1",
                  excerpt:
                    "Primary source supporting the original article statement.",
                  assessment: "supports",
                },
              ],
            }
          : {
              verdict: variant === "wiki-pass" ? "pass" : "fail",
              files: input.files.map((f: any) => ({
                path: f.path,
                meaningPreserved: true,
                naturalLanguage: true,
                referencesSupported: true,
                issues: variant === "wiki-pass" ? [] : ["原文の条件が脱落"],
              })),
            };
      return new Response(
        JSON.stringify({
          id: "resp_fixture",
          status: "completed",
          usage: { input_tokens: 1000, output_tokens: 200 },
          output: [
            ...(research
              ? [
                  {
                    type: "web_search_call",
                    status: "completed",
                    action: input.discovery
                      ? { type: "open_page", url: reference }
                      : {
                          type: "search",
                          queries: input.plan.queries,
                          sources: [{ type: "url", url: reference }],
                        },
                  },
                ]
              : []),
            {
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text:
                    research && !input.discovery
                      ? JSON.stringify({
                          verdict: "selected",
                          selectedUrl: reference,
                          fallbackUrl: null,
                          reason: "Synthetic relevant primary source candidate",
                        })
                      : research
                        ? "Verified claim [1].\n```json\n" +
                          JSON.stringify(
                            input.discovery?.retrievalUrls
                              ? {
                                  ...value,
                                  retrieval: [
                                    {
                                      url: input.discovery.retrievalUrls[0],
                                      outcome:
                                        value.verdict === "verified"
                                          ? "retrieved"
                                          : "unavailable",
                                    },
                                  ],
                                }
                              : value,
                          ) +
                          "\n```"
                        : JSON.stringify(
                            input.discovery?.retrievalUrls
                              ? {
                                  ...value,
                                  retrieval: [
                                    {
                                      url: input.discovery.retrievalUrls[0],
                                      outcome:
                                        value.verdict === "verified"
                                          ? "retrieved"
                                          : "unavailable",
                                    },
                                  ],
                                }
                              : value,
                          ),
                  annotations: research
                    ? [
                        {
                          type: "url_citation",
                          url: reference,
                          start_index: 15,
                          end_index: 18,
                        },
                      ]
                    : [],
                },
              ],
            },
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const rejectReview = vi.fn(async () => ({ status: "recorded" }));
    (env.SEO_COORDINATOR as any).rejectReview = rejectReview;
    if (variant === "lost-callback")
      rejectReview.mockResolvedValueOnce({ status: "denied" });
    let jobId: string;
    if (wiki) {
      const started = await start([
        {
          site: "wiki",
          url: "https://asv-wiki.acecore.net/article/example/",
          reason: candidate.reason,
        },
      ]);
      jobId = started.jobId!;
      await request(jobId);
      expect((await request(jobId, "claim", { baseSha, files })).status).toBe(
        "claimed",
      );
    } else jobId = await claimed();
    expect((await request(jobId, "research", {})).status).toBe("researched");
    const finalFiles = [];
    let japanese = "";
    for (let step = 0; step < files.length; step++) {
      const result = await request(jobId, "propose", {
        step,
        ...(step === 1 ? { japanese } : {}),
      });
      expect(
        result.status,
        "step=" +
          step +
          " diagnostic=" +
          objects.get("seo-editorial/" + jobId + "/failure.json"),
      ).toBe("proposal_created");
      const file = {
        path: result.file.path,
        content: await format(result.file.content, portalFormat),
      };
      finalFiles.push(file);
      if (step === 0) japanese = file.content;
    }
    if (variant === "wiki-pass") {
      const reviewed = await request(jobId, "review", { files: finalFiles });
      expect(reviewed.status).toBe("reviewed");
      expect(mocks.infer).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(
        sql.prepare("SELECT count(*) n FROM seo_budget_calls").get()!.n,
      ).toBe(5);
      const preflight = JSON.parse(
        objects.get("seo-editorial/" + jobId + "/eligibility-preflight.json")!,
      );
      expect(preflight.allocationVersion).toBe(2);
      expect(preflight.generationAllocation).toHaveLength(1);
      expect(preflight.generationAllocation[0].maxBytes).toBe(58333);
      return;
    }
    if (variant === "missing-manifest")
      objects.delete("seo-editorial/" + jobId + "/step-0-call.json");
    if (variant === "budget-unknown")
      sql.exec(
        "UPDATE seo_budget_calls SET status='unresolved' WHERE id=(SELECT call_id FROM seo_editorial_checks WHERE phase='plan')",
      );
    if (variant === "source-changed")
      objects.set(
        "seo-editorial/" + jobId + "/source.json",
        JSON.stringify([]),
      );
    if (variant === "publication")
      sql.exec("UPDATE seo_editorial_jobs SET publication_started=1");
    if (variant === "malformed-review") {
      const normal = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (...args) => {
        const r = await normal(...args);
        const v = await r.json();
        v.output[0].content[0].text = JSON.stringify({
          verdict: "fail",
          files: [],
        });
        return Response.json(v);
      });
    }
    const review = await request(jobId, "review", { files: finalFiles });
    if (
      [
        "missing-manifest",
        "budget-unknown",
        "source-changed",
        "publication",
        "malformed-review",
      ].includes(variant)
    ) {
      expect(review.status).toBe("unresolved");
      expect(rejectReview).not.toHaveBeenCalled();
      return;
    }
    expect(review.status).toBe("review_failed");
    if (variant === "late") {
      clock.mockReturnValue(now + 31 * 60000);
      expect(Date.now()).toBeGreaterThan(now + 30 * 60000);
    }
    if (variant === "receipt-store-failure") {
      const normal = env.CMS_AI_IMAGES.put.bind(env.CMS_AI_IMAGES);
      env.CMS_AI_IMAGES.put = vi.fn(async (k: any, ...args: any[]) =>
        k.endsWith("/review-rejection.json") ? null : normal(k, ...args),
      ) as any;
    }
    const body = {
      baseSha,
      offerSha256:
        variant === "bad-offer" ? "e".repeat(64) : review.offerSha256,
      refs: [],
      pullRequests: variant === "pr-exists" ? [1] : [],
    };
    const result = await request(jobId, "review-reject", body);
    const safe = ["valid", "lost-callback"].includes(variant);
    expect(result.status).toBe(
      variant === "valid" ? "review_rejected" : "unresolved",
    );
    expect(
      sql.prepare("SELECT count(*) n FROM seo_all_review_rejections").get()!.n,
    ).toBe(safe ? 1 : 0);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(mocks.infer).toHaveBeenCalledTimes(wiki ? 1 : 9);
    if (safe) {
      const budget = sql
        .prepare("SELECT * FROM seo_budget_calls ORDER BY id")
        .all();
      if (variant === "lost-callback") clock.mockReturnValue(now + 31 * 60000);
      expect(await editorialStatus(env, { runId })).toMatchObject({
        status: "review_rejected",
      });
      expect((await request(jobId, "review-reject", body)).status).toBe(
        "review_rejected",
      );
      expect(
        (
          await request(jobId, "publish", {
            filesSha256: await sha256(JSON.stringify(finalFiles)),
          })
        ).status,
      ).toBe("unresolved");
      expect(
        sql.prepare("SELECT * FROM seo_budget_calls ORDER BY id").all(),
      ).toEqual(budget);
      expect(
        sql
          .prepare(
            "SELECT next_step,publication_started FROM seo_editorial_jobs",
          )
          .get(),
      ).toEqual({ next_step: wiki ? 1 : 9, publication_started: 0 });
      for (const query of [
        "DELETE FROM seo_all_review_rejections",
        "UPDATE seo_editorial_jobs SET next_step=0",
        "UPDATE seo_budget_calls SET status='reserved'",
      ])
        expect(() => sql.exec(query)).toThrow();
      expect(complete).not.toHaveBeenCalled();
    }
  });
  it("integrates fresh search, nine accepted files, final-byte AI review and publish under one durable budget/deadline", async () => {
    env.SEO_RESEARCH_ENABLED = "true";
    env.OPENAI_API_KEY_STORE = { get: async () => "fixture-secret" };
    const reference = "https://docs.example.org/new-guide";
    const infer = mocks.infer.getMockImplementation()!;
    mocks.infer.mockImplementation(async (...args) => {
      const result = await infer(...args);
      result.changes[0].content += "\n[Reference](" + reference + ")\n";
      return result;
    });
    const fetchMock = vi.fn(async (_url, options) => {
      const payload = JSON.parse(options.body);
      const input = JSON.parse(payload.input);
      const research = !!payload.tools;
      const value = input.claims
        ? {
            verdict: "ready",
            claimId: input.claims[0].id,
            targetQuote: input.claims[0].contextParts.find(
              (p: any) => p.selectable,
            ).quote,
            conditions: [
              input.claims[0].contextParts.find((p: any) => p.selectable).quote,
            ],
            anchors: ["Original"],
            queries: ["Original article guide"],
          }
        : research
          ? {
              verdict: "verified",
              sources: [
                {
                  url: reference,
                  title: "Guide",
                  claimId: "claim-1",
                  excerpt:
                    "Primary source supporting the original article statement.",
                  assessment: "supports",
                },
              ],
            }
          : {
              verdict: "pass",
              files: input.files.map((f: any) => ({
                path: f.path,
                meaningPreserved: true,
                naturalLanguage: true,
                referencesSupported: true,
                issues: [],
              })),
            };
      return new Response(
        JSON.stringify({
          id: "resp_fixture",
          status: "completed",
          usage: { input_tokens: 1000, output_tokens: 200 },
          output: [
            ...(research
              ? [
                  {
                    type: "web_search_call",
                    status: "completed",
                    action: input.discovery
                      ? { type: "open_page", url: reference }
                      : {
                          type: "search",
                          queries: input.plan.queries,
                          sources: [{ type: "url", url: reference }],
                        },
                  },
                ]
              : []),
            {
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text:
                    research && !input.discovery
                      ? JSON.stringify({
                          verdict: "selected",
                          selectedUrl: reference,
                          fallbackUrl: null,
                          reason: "Synthetic relevant primary source candidate",
                        })
                      : research
                        ? "Verified claim [1].\n```json\n" +
                          JSON.stringify(
                            input.discovery?.retrievalUrls
                              ? {
                                  ...value,
                                  retrieval: [
                                    {
                                      url: input.discovery.retrievalUrls[0],
                                      outcome:
                                        value.verdict === "verified"
                                          ? "retrieved"
                                          : "unavailable",
                                    },
                                  ],
                                }
                              : value,
                          ) +
                          "\n```"
                        : JSON.stringify(
                            input.discovery?.retrievalUrls
                              ? {
                                  ...value,
                                  retrieval: [
                                    {
                                      url: input.discovery.retrievalUrls[0],
                                      outcome:
                                        value.verdict === "verified"
                                          ? "retrieved"
                                          : "unavailable",
                                    },
                                  ],
                                }
                              : value,
                          ),
                  annotations: research
                    ? [
                        {
                          type: "url_citation",
                          url: reference,
                          start_index: 15,
                          end_index: 18,
                        },
                      ]
                    : [],
                },
              ],
            },
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const jobId = await claimed();
    expect((await request(jobId, "research", {})).status).toBe("researched");
    const finalFiles = [];
    let japanese = "";
    for (let step = 0; step < 9; step++) {
      const result = await request(jobId, "propose", {
        step,
        ...(step === 1 ? { japanese } : {}),
      });
      expect(
        result.status,
        "step=" +
          step +
          " diagnostic=" +
          objects.get("seo-editorial/" + jobId + "/failure.json"),
      ).toBe("proposal_created");
      const file = {
        path: result.file.path,
        content: await format(result.file.content, portalFormat),
      };
      finalFiles.push(file);
      if (step === 0) japanese = file.content;
    }
    const review = await request(jobId, "review", { files: finalFiles });
    expect(review.status).toBe("reviewed");
    expect(review.receipt.filesSha256).toBe(
      await sha256(JSON.stringify(finalFiles)),
    );
    expect(
      (
        await request(jobId, "publish", {
          filesSha256: review.receipt.filesSha256,
        })
      ).status,
    ).toBe("publishing");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(mocks.infer).toHaveBeenCalledTimes(9);
    expect(sql.prepare("SELECT count(*) n FROM seo_budget_runs").get()?.n).toBe(
      1,
    );
    expect(
      sql
        .prepare(
          "SELECT count(*) n FROM seo_budget_calls WHERE status='complete'",
        )
        .get()?.n,
    ).toBe(13);
    expect(
      Number(
        sql
          .prepare("SELECT sum(reserved_micros) cost FROM seo_budget_calls")
          .get()?.cost,
      ),
    ).toBeLessThan(1000000);
    expect(
      sql.prepare("SELECT deadline FROM seo_budget_runs").get()?.deadline,
    ).toBe(now + 20 * 60_000);
  });
  it("keeps new research disabled by default and restricts the canary to its exact editorial ID", async () => {
    env.SEO_RESEARCH_CANARY_RUN_ID =
      "editorial-00000000-0000-4000-8000-000000000002";
    await inspecting();
    expect(
      sql.prepare("SELECT protocol_version FROM seo_editorial_jobs").get()
        ?.protocol_version,
    ).toBe(1);
  });
  it.each(["flag", "canary"])(
    "requires research and review for a new %s v2 job before any generation/publish",
    async (kind) => {
      if (kind === "flag") env.SEO_RESEARCH_ENABLED = "true";
      else env.SEO_RESEARCH_CANARY_RUN_ID = runId;
      const jobId = await claimed();
      expect(
        sql.prepare("SELECT protocol_version FROM seo_editorial_jobs").get()
          ?.protocol_version,
      ).toBe(2);
      expect((await request(jobId, "propose", { step: 0 })).status).toBe(
        "unresolved",
      );
      expect(mocks.infer).not.toHaveBeenCalled();
      expect(claim).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({ status: "unresolved" }),
      );
    },
  );
  it("blocks a v2 publish even if all nine generation steps exist without a review receipt", async () => {
    env.SEO_RESEARCH_ENABLED = "true";
    const jobId = await claimed();
    sql
      .prepare(
        "UPDATE seo_editorial_jobs SET next_step=9,status='generated' WHERE id=?",
      )
      .run(jobId);
    expect(
      (await request(jobId, "publish", { filesSha256: "a".repeat(64) })).status,
    ).toBe("unresolved");
  });
  it("accepts the canary indentation defect after one paid call and preserves the original proposal", async () => {
    const jobId = await claimed();
    const infer = mocks.infer.getMockImplementation()!;
    mocks.infer.mockImplementationOnce(async (...args) => {
      const result = await infer(...args);
      result.changes[0].content = result.changes[0].content.replace(
        "\ndescription:",
        "\n description:",
      );
      return result;
    });
    const result = await request(jobId, "propose", { step: 0 });
    expect(result.status).toBe("proposal_created");
    expect(result.file.content).toContain("\ndescription: Revised description");
    expect(mocks.infer).toHaveBeenCalledTimes(1);
    expect(
      sql.prepare("SELECT status FROM seo_budget_calls").get()?.status,
    ).toBe("complete");
    expect(
      sql.prepare("SELECT next_step FROM seo_editorial_jobs").get()?.next_step,
    ).toBe(1);
    const raw = [...objects.entries()].find(([key]) =>
      key.startsWith("seo-proposals/"),
    )![1];
    expect(JSON.parse(raw).changes[0].content).toContain("\n description:");
    expect(objects.has("seo-editorial/" + jobId + "/step-0.json")).toBe(true);
    expect(complete).not.toHaveBeenCalled();
  });
  it.each([1, 2])(
    "records safe metadata rejection v%i without retrying or releasing the completed reservation",
    async (version) => {
      legacyMetadata = version === 1;
      const jobId = await claimed();
      const infer = mocks.infer.getMockImplementation()!;
      mocks.infer.mockImplementationOnce(async (...args) => {
        const result = await infer(...args);
        result.changes[0].content =
          version === 1
            ? result.changes[0].content.replace(
                "author: Gui",
                "author: Changed",
              )
            : result.changes[0].content.replace(
                "---\n",
                "---\nauthor: Changed\n",
              );
        return result;
      });
      expect(await request(jobId, "propose", { step: 0 })).toEqual({
        status: "unresolved",
      });
      const key = "seo-editorial/" + jobId + "/failure.json";
      const failure = {
        operation: "propose",
        step: 0,
        code:
          version === 1 ? "seo_immutable_metadata" : "seo_metadata_transport",
      };
      expect(JSON.parse(objects.get(key)!)).toEqual(failure);
      expect(
        sql.prepare("SELECT status FROM seo_budget_calls").get()?.status,
      ).toBe("complete");
      expect(
        sql.prepare("SELECT next_step FROM seo_editorial_jobs").get()
          ?.next_step,
      ).toBe(0);
      expect(objects.has("seo-editorial/" + jobId + "/step-0.json")).toBe(
        false,
      );
      expect(complete).toHaveBeenCalledWith({
        runId,
        articleKey: "portal:" + sourcePath,
        status: "unresolved",
      });
      await request(jobId, "propose", { step: 0 });
      expect(JSON.parse(objects.get(key)!)).toEqual(failure);
      expect(mocks.infer).toHaveBeenCalledTimes(1);
      expect(
        sql.prepare("SELECT COUNT(*) AS n FROM seo_budget_calls").get()?.n,
      ).toBe(1);
    },
  );
  it("never persists raw exceptions and still terminates if diagnostic storage fails", async () => {
    const jobId = await claimed();
    env.CMS_AI_IMAGES.get = vi.fn(async () => {
      throw new Error("private upstream diagnostic sentinel");
    });
    expect(await request(jobId, "propose", { step: 0 })).toEqual({
      status: "unresolved",
    });
    const key = "seo-editorial/" + jobId + "/failure.json";
    expect(JSON.parse(objects.get(key)!)).toEqual({
      operation: "propose",
      step: 0,
      code: "unexpected_error",
    });
    expect([...objects.values()].join()).not.toContain(
      "private upstream diagnostic sentinel",
    );
    env.CMS_AI_IMAGES.put = vi.fn(async () => {
      throw new Error("private storage diagnostic sentinel");
    });
    expect(await request(jobId, "propose", { step: 0 })).toEqual({
      status: "unresolved",
    });
    expect(row().status).toBe("unresolved");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(mocks.infer).not.toHaveBeenCalled();
  });
  it("has no HTTP start route and cannot create jobs from an OIDC URL", async () => {
    for (const path of [
      "/seo-runner/start",
      "/seo-runner/status",
      "/seo-runner/jobs/new",
    ]) {
      const response = await handleSeoRunnerRequest(
        new Request("https://cms-ai.acecore.net" + path, {
          method: "POST",
          body: "{}",
        }),
        env,
      );
      expect(response.status).toBe(404);
    }
    expect(
      sql.prepare("SELECT COUNT(*) AS n FROM seo_editorial_runs").get()?.n,
    ).toBe(0);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("persists empty/non-article results without dispatch or callback", async () => {
    expect(await start([])).toMatchObject({ status: "started" });
    expect(await editorialStatus(env, { runId })).toEqual({
      status: "no_eligible_article",
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
  it("skips two non-article top results, dispatches only the third, and deduplicates concurrent starts", async () => {
    const candidates = [
      { site: "corporate", url: "https://acecore.net/en/" },
      { site: "portal", url: "https://asv.acecore.net/es/" },
      candidate,
    ];
    await Promise.all([start(candidates), start(candidates)]);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(row().candidate_index).toBe(2);
    expect(row().budget_run_id).toMatch(/^seo-/);
    const previous = row().budget_run_id;
    await start(candidates);
    expect(row().budget_run_id).toBe(previous);
    expect(
      await startEditorial(env, {
        runId,
        deadline: now + 30 * 60_000,
        candidates,
      }),
    ).toEqual({ status: "unresolved" });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });
  it("advances one candidate at a time only after explicit ineligibility", async () => {
    const result = await start([
      candidate,
      { site: "corporate", url: "https://acecore.net/blog/example/" },
    ]);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    await request(result.jobId!);
    await request(result.jobId!, "skip", {});
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(mocks.dispatch.mock.calls[1][1].id).toBe("acecore-net");
  });
  it("never retries unknown dispatch, keeping the external/internal run mapping", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("transport"));
    expect(await start()).toMatchObject({ status: "unresolved" });
    expect(await editorialStatus(env, { runId })).toEqual({
      status: "unresolved",
    });
    await start();
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });
  it("binds a job to one GitHub run and denies another repository/run", async () => {
    const jobId = await inspecting();
    mocks.identity = {
      site: SITES[0],
      repository: SITES[0].repository,
      runId: "100",
      workflowSha: baseSha,
    };
    await expect(request(jobId)).rejects.toMatchObject({ status: 403 });
    mocks.identity = {
      site: seoSite("portal")!.site,
      repository: seoSite("portal")!.site.repository,
      runId: "101",
      workflowSha: baseSha,
    };
    await expect(request(jobId)).rejects.toMatchObject({ status: 403 });
    expect(mocks.infer).not.toHaveBeenCalled();
  });
  it("cannot generate without a coordinator claim or a current workflow source SHA", async () => {
    const jobId = await inspecting();
    expect(await request(jobId, "propose", { step: 0 })).toEqual({
      status: "unresolved",
    });
    expect(mocks.infer).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });
  it("preserves a lost claim outcome, does not generate or try a second article", async () => {
    const jobId = await inspecting();
    claim.mockRejectedValueOnce(new Error("lost response"));
    expect(await request(jobId, "claim", { baseSha, files })).toEqual({
      status: "unresolved",
    });
    expect(mocks.infer).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith({
      runId,
      articleKey: "portal:" + sourcePath,
      status: "unresolved",
    });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });
  it("formats Japanese tables, hands off all eight locales and passes final assertions under one deadline", async () => {
    const infer = mocks.infer.getMockImplementation()!;
    mocks.infer.mockImplementation(async (...args) => {
      const result = await infer(...args);
      // Canary: first translation rewrote the old timestamp's timezone suffix.
      if (result.changes[0].path !== sourcePath)
        result.changes[0].content = result.changes[0].content.replace(
          "lastUpdated: 2026-10-09T15:00:00+09:00",
          "lastUpdated: 2026-10-09T15:00:00Z",
        );
      return result;
    });
    files = files.map((file) => ({
      ...file,
      content: file.content + articleBody,
    }));
    const identity = sourceIdentity("portal", candidate.url, files, now)!;
    const jobId = await claimed();
    expect(claim).toHaveBeenCalledWith({
      runId,
      articleKey: "portal:" + sourcePath,
      sourceSha256: await sha256(files[0].content),
    });
    let japanese = "";
    const finalFiles = [];
    for (let step = 0; step < 9; step++) {
      const response = await request(jobId, "propose", {
        step,
        ...(step === 1 ? { japanese } : {}),
      });
      expect(response.status).toBe("proposal_created");
      const instruction = mocks.infer.mock.calls.at(-1)![2].instruction;
      expect(instruction).toContain("1 call = 1 file");
      expect(instruction).toContain(
        "成功時とエラー時など対になる確認は両方を残し",
      );
      expect(instruction).toContain("原文にない手順や目的は補わない");
      expect(instruction).toContain("後続の独立AI校閲が実際に判定する");
      expect(instruction).toContain(
        "第" +
          (step + 1) +
          "/9段階、locale=" +
          (step === 0 ? "ja" : SEO_LOCALES[step - 1]) +
          "、出力先=" +
          response.file.path +
          "のみ",
      );
      expect(instruction).toContain(
        "既存8 localeを1言語ずつ後続callへ割り当て",
      );
      expect(instruction).toContain("同一予算run ID・同一絶対deadline");
      expect(instruction).toContain(
        "全対象localeの実改訂・検証が揃うまでPRは作らず",
      );
      expect(instruction).toContain(
        "全locale反映・同一PR要件はcontrollerが工程全体で満たす",
      );
      expect(instruction).toContain(
        "判断材料が不足ならchangesを空にしてclarificationを返す",
      );
      if (step > 0) {
        expect(instruction).toContain("冠詞と名詞の性数、主語と動詞の一致");
        expect(instruction).toContain("文法を直すために意味を変えない");
        expect(instruction).toContain(
          "title・description・見出し・本文・リンク説明の通常語を担当言語へ訳し、日本語の断片を残さない",
        );
        expect(instruction).toContain(
          "韓国語の文中に日本語の『入口』などを混在させず",
        );
        expect(instruction).toContain(
          "zh-cnの正当な漢字表現は日本語残存と混同しない",
        );
        expect(instruction).toContain(
          "コード・コマンド・URL・製品名・固有名・引用を削除や改変しない",
        );
        expect(instruction).toContain(
          "保護対象と検証要件が両立しない場合はclarificationを返す",
        );
        expect(instruction).toContain(
          "見出しレベル・リンクの役割・コードtokenを対応させ",
        );
      } else {
        expect(instruction).not.toContain(
          "対象localeの既存content/i18n検証要件",
        );
      }
      const formatted = await format(response.file.content, portalFormat);
      finalFiles.push({ ...response.file, content: formatted });
      if (step === 0) {
        japanese = formatted;
        expect(response.file.content.replace(/\s/g, "")).not.toBe(
          japanese.replace(/\s/g, ""),
        );
      } else {
        expect(response.file.content).toContain(
          "sha256:" + (await sha256(japanese)),
        );
        // Step 1 and later snapshots must pass the exact formatted source to AI.
        expect(
          mocks.infer.mock.calls
            .at(-1)![3]
            .find((file: { path: string }) => file.path === sourcePath).content,
        ).toBe(
          prepareEditorialTransport(
            [{ path: sourcePath, content: japanese }],
            sourcePath,
            sourcePath,
            "",
            2,
            "",
            2,
            identity.target.spec.editableFields,
            2,
          ).files[0].content,
        );
      }
    }
    expect(
      JSON.parse(objects.get("seo-editorial/" + jobId + "/formatted-ja.json")!)
        .content,
    ).toBe(japanese);
    await expect(
      assertEditorialFiles(identity, files, finalFiles),
    ).resolves.toBeUndefined();
    expect(
      sql.prepare("SELECT COUNT(*) AS n FROM seo_budget_runs").get()?.n,
    ).toBe(1);
    expect(
      sql.prepare("SELECT COUNT(*) AS n FROM seo_budget_calls").get()?.n,
    ).toBe(9);
    expect(
      sql.prepare("SELECT deadline FROM seo_budget_runs").get()?.deadline,
    ).toBe(now + 20 * 60_000);
    expect(sql.prepare("SELECT id FROM seo_budget_runs").get()?.id).toBe(
      row().budget_run_id,
    );
    expect(await request(jobId, "publish", {})).toEqual({
      status: "publishing",
    });
    clock.mockReturnValue(now + 20 * 60_000 + 1);
    const prUrl =
      "https://github.com/acecore-systems/aceserver-portal/pull/999";
    expect(await request(jobId, "finish", { prUrl })).toEqual({
      status: "draft_pr",
      articleKey: "portal:" + sourcePath,
      prUrl,
    });
    expect(complete).toHaveBeenCalledWith({
      runId,
      articleKey: "portal:" + sourcePath,
      status: "draft_pr",
      prUrl,
    });
    await editorialStatus(env, { runId });
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it("preserves a legitimate clarification without forcing generation or starting translations", async () => {
    const jobId = await claimed();
    const infer = mocks.infer.getMockImplementation()!;
    const clarification = "本文の根拠だけでは担当箇所の説明を判断できません。";
    mocks.infer.mockImplementationOnce(async (...args) => {
      await infer(...args);
      return { changes: [], summary: "根拠不足で停止", clarification };
    });
    expect(await request(jobId, "propose", { step: 0 })).toEqual({
      status: "unresolved",
    });
    expect(mocks.infer).toHaveBeenCalledTimes(1);
    expect(
      sql.prepare("SELECT next_step,status FROM seo_editorial_jobs").get(),
    ).toMatchObject({ next_step: 0, status: "unresolved" });
    const calls = sql
      .prepare("SELECT status,reserved_micros FROM seo_budget_calls")
      .all();
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe("complete");
    expect(calls[0].reserved_micros).toBeGreaterThan(0);
    const proposal = [...objects.entries()].find(([key]) =>
      key.startsWith("seo-proposals/"),
    )![1];
    expect(JSON.parse(proposal)).toMatchObject({ changes: [], clarification });
    expect(objects.has("seo-editorial/" + jobId + "/step-0.json")).toBe(false);
    expect(complete).toHaveBeenCalledWith({
      runId,
      articleKey: "portal:" + sourcePath,
      status: "unresolved",
    });
    expect(await request(jobId, "publish", {})).toEqual({
      status: "unresolved",
    });
    expect(mocks.infer).toHaveBeenCalledTimes(1);
  });
  it("rejects altered formatted copy before any translation call and retains step 0 and its reservation", async () => {
    files = files.map((file) => ({
      ...file,
      content: file.content + articleBody,
    }));
    const jobId = await claimed();
    const accepted = await request(jobId, "propose", { step: 0 });
    const before = sql.prepare("SELECT * FROM seo_budget_calls").all();
    const japanese = (
      await format(accepted.file.content, portalFormat)
    ).replace("接続方法", "変更された文言");
    expect(await request(jobId, "propose", { step: 1, japanese })).toEqual({
      status: "unresolved",
    });
    expect(mocks.infer).toHaveBeenCalledTimes(1);
    expect(sql.prepare("SELECT * FROM seo_budget_calls").all()).toEqual(before);
    expect(
      sql.prepare("SELECT next_step,status FROM seo_editorial_jobs").get(),
    ).toMatchObject({ next_step: 1, status: "unresolved" });
    expect(
      JSON.parse(objects.get("seo-editorial/" + jobId + "/step-0.json")!),
    ).toEqual(accepted.file);
    expect(objects.has("seo-editorial/" + jobId + "/formatted-ja.json")).toBe(
      false,
    );
    expect(
      JSON.parse(objects.get("seo-editorial/" + jobId + "/failure.json")!),
    ).toEqual({ operation: "propose", step: 1, code: "format_source_changed" });
  });
  it("retains budget reservations on an unknown API outcome and retries only the idempotent callback", async () => {
    const jobId = await claimed();
    mocks.infer.mockImplementationOnce(
      async (_e, _s, _j, _f, _h, _v, beforeRequest) => {
        await beforeRequest("gpt-6-luna", {
          max_completion_tokens: 12000,
          service_tier: "default",
        });
        throw new Error("timeout");
      },
    );
    complete.mockRejectedValueOnce(new Error("lost callback"));
    expect(await request(jobId, "propose", { step: 0 })).toEqual({
      status: "unresolved",
    });
    expect(
      sql.prepare("SELECT status,reserved_micros FROM seo_budget_calls").get(),
    ).toMatchObject({ status: "unresolved" });
    expect(await editorialStatus(env, { runId })).toMatchObject({
      status: "unresolved",
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls.every(([body]) => !("prUrl" in body))).toBe(
      true,
    );
    expect(mocks.infer).toHaveBeenCalledTimes(1);
  });
  it("stops expired runs and partial translations without publishing", async () => {
    const jobId = await claimed();
    expect((await request(jobId, "propose", { step: 0 })).status).toBe(
      "proposal_created",
    );
    clock.mockReturnValue(now + 20 * 60_000);
    expect(
      await request(jobId, "propose", { step: 1, japanese: files[0].content }),
    ).toEqual({ status: "unresolved" });
    expect(mocks.infer).toHaveBeenCalledTimes(1);
    expect(row().status).toBe("unresolved");
    expect(complete).toHaveBeenCalledWith({
      runId,
      articleKey: "portal:" + sourcePath,
      status: "unresolved",
    });
  });
  it("stops translation when the shared $1.25 run cap is exhausted", async () => {
    const jobId = await claimed();
    const normal = mocks.infer.getMockImplementation()!;
    mocks.infer.mockImplementation(async (...args) => {
      const reserve = args[6];
      args[6] = (model: string, payload: Record<string, unknown>) =>
        reserve(model, {
          ...payload,
          messages: [{ role: "user", content: "x".repeat(160_000) }],
        });
      return normal(...args);
    });
    let japanese = "",
      outcome = "";
    for (let step = 0; step < 9; step++) {
      const response = await request(jobId, "propose", {
        step,
        ...(step === 1 ? { japanese } : {}),
      });
      outcome = response.status;
      if (outcome !== "proposal_created") break;
      if (step === 0) japanese = response.file.content;
    }
    expect(outcome).toBe("unresolved");
    const ledger = sql
      .prepare(
        "SELECT SUM(reserved_micros) AS amount,COUNT(*) AS n FROM seo_budget_calls",
      )
      .get()!;
    expect(ledger.amount).toBeLessThanOrEqual(1_250_000);
    expect(ledger.n).toBeLessThan(9);
    expect(row().status).toBe("unresolved");
    expect(complete).toHaveBeenCalledWith({
      runId,
      articleKey: "portal:" + sourcePath,
      status: "unresolved",
    });
  });
});

async function insufficientOffer() {
  env.SEO_RESEARCH_ENABLED = "true";
  env.OPENAI_API_KEY_STORE = { get: async () => "fixture" };
  (env.SEO_COORDINATOR as any).rejectResearch = vi.fn(async () => ({
    status: "recorded",
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        id: "resp_insufficient",
        status: "completed",
        usage: { input_tokens: 100, output_tokens: 100 },
        output: [
          {
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  verdict: "insufficient",
                  claimId: "",
                  targetQuote: "",
                  conditions: [],
                  anchors: [],
                  queries: [],
                }),
                annotations: [],
              },
            ],
          },
        ],
      }),
    ),
  );
  const jobId = await claimed();
  const offer = await request(jobId, "research", {});
  expect(offer.status).toBe("research_insufficient");
  return {
    jobId,
    body: {
      baseSha,
      offerSha256: offer.offerSha256,
      refs: [],
      pullRequests: [],
    },
  };
}
it("terminalizes only a verified insufficient receipt, preserves paid evidence and replays without AI", async () => {
  const { jobId, body } = await insufficientOffer();
  const budget = sql.prepare("SELECT * FROM seo_budget_calls").all();
  const result = await request(jobId, "research-reject", body);
  expect(result.status).toBe("research_rejected");
  expect((await editorialStatus(env, { runId })).status).toBe(
    "research_rejected",
  );
  expect(await request(jobId, "research-reject", body)).toEqual(result);
  expect(sql.prepare("SELECT * FROM seo_budget_calls").all()).toEqual(budget);
  expect(mocks.infer).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await request(jobId, "propose", { step: 0 })).toEqual({
    status: "unresolved",
  });
  expect((await editorialStatus(env, { runId })).status).toBe(
    "research_rejected",
  );
  const receipt = sql.prepare("SELECT * FROM seo_research_rejections").get()!;
  for (const query of [
    "DELETE FROM seo_research_rejections",
    "DELETE FROM seo_budget_calls",
    "UPDATE seo_budget_calls SET reserved_micros=1",
    "DELETE FROM seo_editorial_checks",
    "UPDATE seo_research_rejections SET receipt_sha256='other'",
    "UPDATE seo_editorial_jobs SET status='publishing'",
    "UPDATE seo_editorial_runs SET deadline=deadline+1000",
    "UPDATE seo_editorial_jobs SET generation_started=1",
  ])
    expect(() => sql.exec(query)).toThrow();
  expect(sql.prepare("SELECT * FROM seo_research_rejections").get()).toEqual(
    receipt,
  );
});
it.each([
  "ref",
  "pr",
  "hash",
  "source",
  "generation",
  "publishing",
  "artifact",
  "unknown",
  "deadline",
  "old",
])("rejects unsafe terminal receipt: %s", async (kind) => {
  const { jobId, body } = await insufficientOffer();
  if (kind === "ref") body.refs.push("present" as never);
  if (kind === "pr") body.pullRequests.push(1 as never);
  if (kind === "hash") body.offerSha256 = "b".repeat(64);
  if (kind === "source")
    sql.exec("UPDATE seo_editorial_jobs SET source_sha256='wrong'");
  if (kind === "generation")
    sql.exec("UPDATE seo_editorial_jobs SET generation_started=1");
  if (kind === "publishing")
    sql.exec("UPDATE seo_editorial_jobs SET publication_started=1");
  if (kind === "artifact")
    objects.set("seo-editorial/" + jobId + "/step-0.json", "{}");
  if (kind === "unknown")
    sql.exec("UPDATE seo_budget_calls SET status='unresolved'");
  if (kind === "deadline") clock.mockReturnValue(now + 30 * 60000);
  if (kind === "old")
    sql.exec("UPDATE seo_editorial_jobs SET research_contract=1");
  expect((await request(jobId, "research-reject", body)).status).toBe(
    "unresolved",
  );
  expect(
    sql.prepare("SELECT count(*) n FROM seo_research_rejections").get()!.n,
  ).toBe(0);
  expect((env.SEO_COORDINATOR as any).rejectResearch).not.toHaveBeenCalled();
});
it("keeps terminal receipt if callback is lost and retries only that identical callback", async () => {
  const { jobId, body } = await insufficientOffer();
  (env.SEO_COORDINATOR as any).rejectResearch.mockResolvedValueOnce({
    status: "denied",
  });
  expect((await request(jobId, "research-reject", body)).status).toBe(
    "unresolved",
  );
  clock.mockReturnValue(now + 30 * 60000);
  expect((await editorialStatus(env, { runId })).status).toBe(
    "research_rejected",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    sql.prepare("SELECT count(*) n FROM seo_research_rejections").get()!.n,
  ).toBe(1);
});

it("refuses raw-response mutation after offering a rejection", async () => {
  const { jobId, body } = await insufficientOffer();
  const call = sql.prepare("SELECT call_id FROM seo_editorial_checks").get()!
    .call_id;
  const raw = JSON.parse(objects.get("seo-responses/" + call + ".json")!);
  raw.usage.input_tokens = 101;
  objects.set("seo-responses/" + call + ".json", JSON.stringify(raw));
  expect((await request(jobId, "research-reject", body)).status).toBe(
    "unresolved",
  );
  expect(
    sql.prepare("SELECT count(*) n FROM seo_research_rejections").get()!.n,
  ).toBe(0);
});

it.each(["insufficient", "verified-empty", "contract-violation"])(
  "classifies three completed calls without confusing rejection and invalid output: %s",
  async (kind) => {
    env.SEO_RESEARCH_ENABLED = "true";
    env.OPENAI_API_KEY_STORE = { get: async () => "fixture" };
    (env.SEO_COORDINATOR as any).rejectResearch = vi.fn(async () => ({
      status: "recorded",
    }));
    const fetcher = vi.fn(async (_url, options) => {
      const input = JSON.parse(JSON.parse(options.body).input),
        planning = !!input.claims;
      const quote = planning
        ? input.claims[0].contextParts.find((p: any) => p.selectable).quote
        : "";
      const value = planning
        ? {
            verdict: "ready",
            claimId: input.claims[0].id,
            targetQuote: quote,
            conditions: [quote],
            anchors: ["Original"],
            queries: ["Original official documentation"],
          }
        : {
            verdict: kind === "verified-empty" ? "verified" : "insufficient",
            sources: [],
            ...(kind === "contract-violation" ? { extra: true } : {}),
          };
      return Response.json({
        id: "resp_fixture",
        status: "completed",
        usage: { input_tokens: 100, output_tokens: 100 },
        output: [
          ...(!planning
            ? [
                {
                  type: "web_search_call",
                  status: "completed",
                  action: input.discovery
                    ? {
                        type: "open_page",
                        url:
                          input.discovery.retrievalUrls?.[0] ||
                          input.discovery.selectedUrl,
                      }
                    : {
                        type: "search",
                        queries: input.plan.queries,
                        sources: [
                          {
                            type: "url",
                            url: "https://docs.example.org/new-guide",
                          },
                        ],
                      },
                },
              ]
            : []),
          {
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: planning
                  ? JSON.stringify(
                      input.discovery?.retrievalUrls
                        ? {
                            ...value,
                            retrieval: [
                              {
                                url: input.discovery.retrievalUrls[0],
                                outcome:
                                  value.verdict === "verified"
                                    ? "retrieved"
                                    : "unavailable",
                              },
                            ],
                          }
                        : value,
                    )
                  : !input.discovery
                    ? JSON.stringify({
                        verdict: "selected",
                        selectedUrl: "https://docs.example.org/new-guide",
                        fallbackUrl: null,
                        reason: "Synthetic candidate",
                      })
                    : "No suitable primary source was established.\n```json\n" +
                      JSON.stringify(
                        input.discovery?.retrievalUrls
                          ? {
                              ...value,
                              retrieval: [
                                {
                                  url: input.discovery.retrievalUrls[0],
                                  outcome:
                                    value.verdict === "verified"
                                      ? "retrieved"
                                      : "unavailable",
                                },
                              ],
                            }
                          : value,
                      ) +
                      "\n```",
                annotations: [],
              },
            ],
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const jobId = await claimed(),
      offer = await request(jobId, "research", {});
    expect(offer.status).toBe(
      kind === "insufficient" ? "research_insufficient" : "unresolved",
    );
    if (kind === "insufficient") {
      expect(
        (
          await request(jobId, "research-reject", {
            baseSha,
            offerSha256: offer.offerSha256,
            refs: [],
            pullRequests: [],
          })
        ).status,
      ).toBe("research_rejected");
      const receipt = JSON.parse(
        String(
          sql.prepare("SELECT receipt_json FROM seo_research_rejections").get()!
            .receipt_json,
        ),
      );
      expect(receipt.calls.map((c: any) => [c.phase, c.verdict])).toEqual([
        ["plan", "ready"],
        ["discovery", "ready"],
        ["research", "insufficient"],
      ]);
    }
    expect(
      sql
        .prepare("SELECT DISTINCT run_limit_micros n FROM seo_budget_runs")
        .all(),
    ).toEqual([{ n: 1250000 }]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(mocks.infer).not.toHaveBeenCalled();
  },
);

describe("baseline eligibility before paid work", () => {
  beforeEach(() => {
    env.SEO_RESEARCH_ENABLED = "true";
  });
  it("skips a plan over cap without taking a lock or reserving an API call", async () => {
    const id = await inspecting();
    files[0].content +=
      "\n\n" +
      Array.from(
        { length: 200 },
        (_, i) =>
          `Fact number ${i} has enough original context to form a complete factual sentence.`,
      ).join("\n\n");
    expect((await request(id, "claim", { baseSha, files })).status).toBe(
      "skipped",
    );
    expect(claim).not.toHaveBeenCalled();
    expect(
      sql.prepare("SELECT count(*) n FROM seo_budget_calls").get()!.n,
    ).toBe(0);
    expect(
      JSON.parse(objects.get(`seo-editorial/${id}/eligibility-preflight.json`)!)
        .reasons,
    ).toContain("plan_input_exceeded");
  });
  it("skips oversized original locales with no claim or API reservation and advances naturally", async () => {
    env.SEO_RESEARCH_ENABLED = "true";
    const started = await start([
      candidate,
      { ...candidate, url: "https://asv.acecore.net/en/stories/next/" },
    ]);
    const jobId = started.jobId!;
    await request(jobId);
    files[1].content += "Large translation. ".repeat(6000);
    files[2].content += "Another translation. ".repeat(5000);
    files[3].content += "Third translation. ".repeat(6000);
    files[4].content += "Fourth translation. ".repeat(6000);
    files[5].content += "Fifth translation. ".repeat(6000);
    expect(await request(jobId, "claim", { baseSha, files })).toEqual({
      status: "skipped",
    });
    expect(claim).not.toHaveBeenCalled();
    expect(mocks.infer).not.toHaveBeenCalled();
    expect(
      sql.prepare("SELECT count(*) n FROM seo_budget_calls").get()!.n,
    ).toBe(0);
    expect(row().candidate_index).toBe(1);
    expect(row().job_id).not.toBe(jobId);
    const receipt = JSON.parse(
      objects.get(`seo-editorial/${jobId}/eligibility-preflight.json`)!,
    );
    expect(receipt.reasons).toContain("baseline_review_input_exceeded");
    expect(receipt.evidenceStatus).toBe("not_acquired_size_estimate_only");
    expect(receipt.reviewBytes).toBeGreaterThan(receipt.limits.review);
  });
  it("skips a known oversized single translation before claim even when shared review fits", async () => {
    const started = await start([
      candidate,
      { ...candidate, url: "https://asv.acecore.net/en/stories/next/" },
    ]);
    const id = started.jobId!;
    await request(id);
    sql.exec(
      "DROP TRIGGER seo_retrieval_contract_immutable; UPDATE seo_editorial_jobs SET retrieval_contract=1",
    );
    files[8].content += "Known large translation. ".repeat(2200);
    expect((await request(id, "claim", { baseSha, files })).status).toBe(
      "skipped",
    );
    const receipt = JSON.parse(
      objects.get(`seo-editorial/${id}/eligibility-preflight.json`)!,
    );
    expect(receipt.reviewBytes).toBeLessThan(receipt.limits.review);
    expect(receipt.generationInputs).toHaveLength(9);
    expect(receipt.generationInputs[8].bytes).toBeGreaterThan(45000);
    expect(receipt.reasons).toEqual(["baseline_generation_input_exceeded"]);
    expect(receipt.evidenceStatus).toBe("not_acquired_size_estimate_only");
    expect(claim).not.toHaveBeenCalled();
    expect(mocks.infer).not.toHaveBeenCalled();
    expect(
      sql.prepare("SELECT count(*) n FROM seo_budget_calls").get()!.n,
    ).toBe(0);
    expect(row().candidate_index).toBe(1);
  });
  it("keeps fitting candidates and never calls the placeholder actual evidence", async () => {
    const id = await claimed();
    const receipt = JSON.parse(
      objects.get(`seo-editorial/${id}/eligibility-preflight.json`)!,
    );
    expect(receipt.status).toBe("baseline_fits_not_reviewed");
    expect(receipt.reasons).toEqual([]);
    expect(receipt.generationInputs).toHaveLength(9);
    expect(
      receipt.generationInputs.every((input: any) => input.bytes <= 45000),
    ).toBe(true);
    expect(claim).toHaveBeenCalledOnce();
  });
  it("does not change v1 eligibility", async () => {
    const id = await inspecting();
    sql.exec("UPDATE seo_editorial_jobs SET research_contract=1");
    files[1].content += "Large translation. ".repeat(6000);
    expect((await request(id, "claim", { baseSha, files })).status).toBe(
      "claimed",
    );
    expect(objects.has(`seo-editorial/${id}/eligibility-preflight.json`)).toBe(
      false,
    );
  });
  it("stops before claim when private receipt persistence fails", async () => {
    const id = await inspecting();
    vi.spyOn(env.CMS_AI_IMAGES, "put").mockResolvedValueOnce(null);
    expect((await request(id, "claim", { baseSha, files })).status).toBe(
      "unresolved",
    );
    expect(claim).not.toHaveBeenCalled();
    expect(
      sql.prepare("SELECT count(*) n FROM seo_budget_calls").get()!.n,
    ).toBe(0);
    expect(row().candidate_index).toBe(0);
  });
});

it.each([
  null,
  {
    version: 1 as const,
    checkedAt: "",
    sourceSha256: "a".repeat(64),
    responseId: "fixture",
    queries: [],
    sources: [],
  },
])(
  "keeps explicit fence preservation in researched and original-only instructions",
  (research) => {
    const instruction = buildEditorialInstruction({
      step: 0,
      paths: [sourcePath],
      translationCount: 8,
      reason: "copy",
      research,
    });
    expect(instruction).toContain("言語指定のない```へtext等を補完しない");
    expect(instruction).toContain(
      "完全保持と依頼が両立しなければclarification",
    );
  },
);
it.each([
  "empty",
  "self-selected",
  "unsafe-only",
  "existing-only",
  "incomplete",
  "malformed-source",
  "lost-callback",
])("discovery-only terminal boundary: %s", async (kind) => {
  env.SEO_RESEARCH_ENABLED = "true";
  env.OPENAI_API_KEY_STORE = { get: async () => "fixture" };
  files[0].content += "\n[Existing](https://docs.example.org/existing)\n";
  const callback = vi.fn(async () => ({ status: "recorded" }));
  if (kind === "lost-callback")
    callback.mockResolvedValueOnce({ status: "denied" });
  (env.SEO_COORDINATOR as any).rejectResearch = callback;
  const fetcher = vi.fn(async (_url, options) => {
    const input = JSON.parse(JSON.parse(options.body).input);
    const planning = !!input.claims;
    const quote = planning
      ? input.claims[0].contextParts.find((p: any) => p.selectable).quote
      : "";
    return Response.json({
      id: "resp_discovery_fixture",
      status: !planning && kind === "incomplete" ? "incomplete" : "completed",
      usage: { input_tokens: 100, output_tokens: 100 },
      output: planning
        ? [
            {
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  annotations: [],
                  text: JSON.stringify({
                    verdict: "ready",
                    claimId: input.claims[0].id,
                    targetQuote: quote,
                    conditions: [quote],
                    anchors: ["Original"],
                    queries: ["Original official documentation"],
                  }),
                },
              ],
            },
          ]
        : [
            {
              type: "web_search_call",
              status: "completed",
              action: {
                type: "search",
                queries: input.plan.queries,
                sources:
                  kind === "self-selected"
                    ? [{ type: "url", url: "https://asv.acecore.net/" }]
                    : kind === "unsafe-only"
                      ? [{ type: "url", url: "http://127.0.0.1/private" }]
                      : kind === "existing-only"
                        ? [
                            {
                              type: "url",
                              url: "https://docs.example.org/existing",
                            },
                          ]
                        : kind === "malformed-source"
                          ? [{ title: "Missing URL" }]
                          : [],
              },
            },
            {
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    verdict:
                      kind === "self-selected" ? "selected" : "insufficient",
                    fallbackUrl: null,
                    selectedUrl:
                      kind === "self-selected"
                        ? "https://asv.acecore.net/"
                        : null,
                    reason: "No suitable source in synthetic search",
                  }),
                  annotations: [],
                },
              ],
            },
          ],
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const id = await claimed();
  const result = await request(id, "research", {});
  const safe = !["incomplete", "malformed-source"].includes(kind);
  expect(result.status).toBe(safe ? "research_insufficient" : "unresolved");
  expect(
    sql
      .prepare(
        "SELECT count(*) n FROM seo_editorial_checks WHERE phase='research'",
      )
      .get()!.n,
  ).toBe(0);
  if (safe) {
    const body = {
      baseSha,
      offerSha256: result.offerSha256,
      refs: [],
      pullRequests: [],
    };
    expect((await request(id, "research-reject", body)).status).toBe(
      kind === "lost-callback" ? "unresolved" : "research_rejected",
    );
    const receipt = JSON.parse(
      String(
        sql.prepare("SELECT receipt_json FROM seo_research_rejections").get()!
          .receipt_json,
      ),
    );
    expect(receipt.version).toBe(2);
    expect(receipt.calls.map((c: any) => [c.phase, c.verdict])).toEqual([
      ["plan", "ready"],
      ["discovery", "insufficient"],
    ]);
    const budgets = sql
      .prepare("SELECT * FROM seo_budget_calls ORDER BY id")
      .all();
    clock.mockReturnValue(now + 31 * 60000);
    expect((await editorialStatus(env, { runId })).status).toBe(
      "research_rejected",
    );
    expect(
      sql.prepare("SELECT * FROM seo_budget_calls ORDER BY id").all(),
    ).toEqual(budgets);
    expect(
      sql
        .prepare(
          "SELECT callback_recorded,next_step,generation_started,publication_started FROM seo_editorial_jobs",
        )
        .get(),
    ).toEqual({
      callback_recorded: 1,
      next_step: 0,
      generation_started: 0,
      publication_started: 0,
    });
  } else expect(callback).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(mocks.infer).not.toHaveBeenCalled();
});

it("binds the fixed generation allocation to persisted bytes and rejects tampering before any generation", async () => {
  env.SEO_RESEARCH_ENABLED = "true";
  const id = await claimed();
  const path = `seo-editorial/${id}/eligibility-preflight.json`;
  const raw = objects.get(path)!;
  expect(
    sql.prepare("SELECT input_allocation_sha256 FROM seo_editorial_jobs").get()!
      .input_allocation_sha256,
  ).toBe(await sha256(raw));
  expect(() =>
    sql.exec("UPDATE seo_editorial_jobs SET input_allocation_sha256=NULL"),
  ).toThrow("immutable_input_allocation");
  const value = JSON.parse(raw);
  value.generationAllocation[0].maxBytes++;
  objects.set(path, JSON.stringify(value));
  expect((await request(id, "propose", { step: 0 })).status).toBe("unresolved");
  expect(mocks.infer).not.toHaveBeenCalled();
});

it("skips before claim when the complete new run would exceed remaining monthly budget", async () => {
  env.SEO_RESEARCH_ENABLED = "true";
  const id = await inspecting();
  for (let i = 0; i < 12; i++) {
    sql
      .prepare(
        "INSERT INTO seo_budget_runs(id,article_key,created_at,deadline) VALUES(?,'other',?,?)",
      )
      .run("other" + i, now, now + 60000);
    sql
      .prepare(
        "INSERT INTO seo_budget_calls(id,run_id,month_jst,request_sha256,reserved_micros,created_at,status) VALUES(?,?,'2026-10',?,850000,?,'complete')",
      )
      .run("other" + i, "other" + i, "b".repeat(64), now);
  }
  const before = sql.prepare("SELECT * FROM seo_budget_calls").all();
  expect((await request(id, "claim", { baseSha, files })).status).toBe(
    "skipped",
  );
  expect(
    JSON.parse(objects.get(`seo-editorial/${id}/eligibility-preflight.json`)!)
      .reasons,
  ).toContain("monthly_budget_insufficient");
  expect(claim).not.toHaveBeenCalled();
  expect(sql.prepare("SELECT * FROM seo_budget_calls").all()).toEqual(before);
});

it("skips articles without external factual candidates before lock, budget or model and advances naturally", async () => {
  env.SEO_RESEARCH_ENABLED = "true";
  const started = await start([
    candidate,
    { ...candidate, url: "https://asv.acecore.net/stories/next/" },
  ]);
  const id = started.jobId!;
  await request(id);
  files[0].content = files[0].content.replace(
    "Original body with [reference](https://example.org/guide).",
    "エースサーバーはJava版・統合版のどちらでも遊べる公開サーバーです。",
  );
  expect(await request(id, "claim", { baseSha, files })).toEqual({
    status: "skipped",
  });
  expect(claim).not.toHaveBeenCalled();
  expect(mocks.infer).not.toHaveBeenCalled();
  expect(sql.prepare("SELECT count(*) n FROM seo_budget_calls").get()!.n).toBe(
    0,
  );
  expect(row().candidate_index).toBe(1);
  const saved = JSON.parse(
    objects.get(`seo-editorial/${id}/eligibility-preflight.json`)!,
  );
  expect(saved.reasons).toContain("no_external_factual_claim");
  expect(saved.recovery).toBe(2);
  expect(saved.discoveryPolicy).toBe(5);
  expect(saved.limits.maximumMicros).toBe(1249533);
});
