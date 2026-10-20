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
let claim: ReturnType<typeof vi.fn>, complete: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.clearAllMocks();
  clock = vi.spyOn(Date, "now").mockReturnValue(now);
  sql = new DatabaseSync(":memory:");
  for (const migration of [
    "0004_seo_budget.sql",
    "0005_seo_editorial.sql",
    "0006_seo_research.sql",
    "0007_seo_research_plan.sql",
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
    CMS_AI_MODEL: "gpt-6-luna",
    CMS_AI_DB: {
      prepare,
      batch: async (statements: { query: string; args: unknown[] }[]) => {
        sql.exec("BEGIN");
        try {
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
          ? { json: async () => JSON.parse(objects.get(key)!) }
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
            conditions: [input.claims[0].markdown],
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
                    action: {
                      type: "search",
                      queries: input.plan.queries,
                      sources: [{ url: reference }],
                    },
                  },
                  {
                    type: "web_search_call",
                    status: "completed",
                    action: { type: "open_page", url: reference },
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
                  text: research
                    ? "Verified claim [1].\n```json\n" +
                      JSON.stringify(value) +
                      "\n```"
                    : JSON.stringify(value),
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
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
    ).toBe(12);
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
  it("records safe content rejection evidence without retrying or releasing the completed reservation", async () => {
    const jobId = await claimed();
    const infer = mocks.infer.getMockImplementation()!;
    mocks.infer.mockImplementationOnce(async (...args) => {
      const result = await infer(...args);
      result.changes[0].content = result.changes[0].content.replace(
        "author: Gui",
        "author: Changed",
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
      code: "seo_immutable_metadata",
    };
    expect(JSON.parse(objects.get(key)!)).toEqual(failure);
    expect(
      sql.prepare("SELECT status FROM seo_budget_calls").get()?.status,
    ).toBe("complete");
    expect(
      sql.prepare("SELECT next_step FROM seo_editorial_jobs").get()?.next_step,
    ).toBe(0);
    expect(objects.has("seo-editorial/" + jobId + "/step-0.json")).toBe(false);
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
  });
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
        ).toBe(japanese);
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
  it("stops translation when the shared $1 run cap is exhausted", async () => {
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
    expect(ledger.amount).toBeLessThanOrEqual(1_000_000);
    expect(ledger.n).toBeLessThan(9);
    expect(row().status).toBe("unresolved");
    expect(complete).toHaveBeenCalledWith({
      runId,
      articleKey: "portal:" + sourcePath,
      status: "unresolved",
    });
  });
});
