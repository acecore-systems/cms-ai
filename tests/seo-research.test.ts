import {
  parsePlan,
  focusedInput,
  validatePlannedSearch,
} from "../src/seo-research-plan.ts";
import {
  assertStageInput,
  FULL_RESEARCH_RUN_MICROS,
  STAGE_INPUT_BYTES,
} from "../src/seo-stage-budget.ts";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env.ts";
import {
  parseResearch,
  researchInputs,
  researchArticle,
  reviewArticle,
  loadResearch,
  assertReview,
  type CheckContext,
} from "../src/seo-checks.ts";
import { responseRequest, responsesUpperCost } from "../src/seo-responses.ts";
import { SeoBudget, RATE_VALID_UNTIL, upperCost } from "../src/seo-budget.ts";
import { referenceUrl } from "../src/seo-evidence.ts";
import { acceptEditorialChange, sourceIdentity } from "../src/seo-content.ts";
import { sha256 } from "../src/seo-hash.ts";

const now = Date.parse("2026-10-20T00:00:00Z");
const id = (n: number) =>
  "seo-00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const url = "https://docs.example.org/new-guide";
const source = {
  path: "src/content/blog/example.md",
  content:
    "---\ntitle: Original\ndate: 2026-08-08T00:00:00Z\n---\n\nOriginal useful existing claim in this article.\n",
};
const claim = "Original useful existing claim in this article.";
const researchText = (value: unknown) =>
  "The existing claim is supported by the opened primary guide [1].\n```json\n" +
  JSON.stringify(value) +
  "\n```";
let sql: DatabaseSync,
  env: AppEnv,
  objects: Map<string, string>,
  context: CheckContext,
  fetchMock: ReturnType<typeof vi.fn>;
function provider(
  sources = [
    {
      url,
      title: "Primary guide",
      claimId: "claim-1",
      excerpt: "The existing claim is supported by this source passage.",
      assessment: "supports",
    },
  ],
) {
  return {
    id: "resp_fixture",
    status: "completed",
    usage: { input_tokens: 1000, output_tokens: 100 },
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: {
          type: "search",
          queries: [claim + " 公式 一次資料"],
          sources: [{ url }],
        },
      },
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "open_page", url },
      },
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: researchText({ verdict: "verified", sources }),
            annotations: [
              { type: "url_citation", url, start_index: 59, end_index: 62 },
            ],
          },
        ],
      },
    ],
  };
}
beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  sql = new DatabaseSync(":memory:");
  for (const file of [
    "0004_seo_budget.sql",
    "0005_seo_editorial.sql",
    "0006_seo_research.sql",
    "0007_seo_research_plan.sql",
    "0008_seo_rejection.sql",
    "0009_seo_review_rejection.sql",
    "0010_seo_discovery.sql",
    "0012_seo_run_budget.sql",
    "0013_seo_discovery_policy.sql",
    "0014_seo_generation_syntax.sql",
    "0015_seo_october_budget.sql",
    "0016_seo_external_sources.sql",
    "0017_seo_research_context.sql",
    "0018_seo_allocation_cardinality.sql",
    "0019_seo_variable_review.sql",
  ])
    sql.exec(
      readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"),
    );
  const prepare = (query: string) => {
    const bound = (args: unknown[] = []) => ({
      query,
      args,
      bind: (...args: unknown[]) => bound(args),
      first: async () => sql.prepare(query).get(...(args as [])) || null,
      run: async () => ({
        meta: {
          changes: Number(sql.prepare(query).run(...(args as [])).changes),
        },
      }),
    });
    return bound();
  };
  objects = new Map();
  env = {
    SEO_GENERATION_ENABLED: "true",
    CMS_AI_MODEL: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
    SEO_AI_MODEL: "gpt-6-luna",
    OPENAI_API_KEY_STORE: { get: async () => "fixture-key" },
    CMS_AI_DB: {
      prepare,
      batch: async (items: any[]) => {
        sql.exec("BEGIN");
        try {
          const result = items.map((i) => ({
            meta: {
              changes: Number(sql.prepare(i.query).run(...i.args).changes),
            },
          }));
          sql.exec("COMMIT");
          return result;
        } catch (e) {
          sql.exec("ROLLBACK");
          throw e;
        }
      },
    },
    CMS_AI_IMAGES: {
      put: async (k: string, v: string) => {
        if (objects.has(k)) return null;
        objects.set(k, v);
        return {};
      },
      get: async (k: string) =>
        objects.has(k)
          ? {
              json: async () => JSON.parse(objects.get(k)!),
              text: async () => objects.get(k)!,
            }
          : null,
    },
  } as unknown as AppEnv;
  context = {
    jobId: "job",
    runId: "editorial-run",
    budgetRunId: id(1),
    articleKey: "cherry:" + source.path,
    budgetArticleKey: "homepage-cherry:" + source.path,
    sourceSha256: await sha256(source.content),
    deadline: now + 20 * 60_000,
  };
  sql
    .prepare(
      "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,job_id,created_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      context.runId,
      context.budgetRunId,
      "a".repeat(64),
      context.deadline,
      "[]",
      context.jobId,
      now,
    );
  sql
    .prepare(
      "INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index,protocol_version) VALUES(?,?,?,?,2)",
    )
    .run(context.jobId, context.runId, "homepage-cherry", 0);
  fetchMock = vi.fn(async (_url, options) => {
    const input = JSON.parse(JSON.parse(options.body).input);
    return new Response(
      JSON.stringify(input.claims ? plannerProvider() : provider()),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  sql.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function plannerProvider() {
  const response = provider();
  response.output = response.output.filter((x: any) => x.type === "message");
  const part = (response.output[0] as any).content[0];
  part.text = JSON.stringify({
    verdict: "ready",
    claimId: "claim-1",
    conditions: [claim],
    anchors: ["Original"],
    queries: [claim + " 公式 一次資料"],
  });
  part.annotations = [];
  return response;
}
const research = () => researchArticle(env, context, source);
const budgetCount = () =>
  sql.prepare("SELECT count(*) n FROM seo_budget_calls").get()!.n;

describe("SEO fresh search evidence and retained budget", () => {
  it("rejects the prior canary shape: strict JSON insufficient, three support items, one open, zero citations", () => {
    // Redacted shape of the saved response; no private article or reasoning payload.
    const result = provider();
    const part: any = (result.output[2] as any).content[0];
    const item = JSON.parse(part.text.split("```json\n")[1].split("\n```")[0])
      .sources[0];
    part.text = JSON.stringify({
      verdict: "insufficient",
      sources: [
        { ...item, url: "https://docs.example.org/first" },
        { ...item, url: "https://docs.example.org/second" },
        item,
      ],
    });
    part.annotations = [];
    expect(() =>
      parseResearch(result, source.content, context.sourceSha256, now),
    ).toThrow("seo_research_evidence");
  });
  it("reserves article/instructions on every search pass and fits a representative existing nine-call run within $1", async () => {
    const budget = new SeoBudget(env.CMS_AI_DB);
    // Existing E2E reservation amount is a budget fixture, not a new live call.
    await budget.reserve(
      context.budgetRunId,
      id(81),
      context.budgetArticleKey,
      "a".repeat(64),
      647117,
      now,
      context.deadline,
    );
    await research();
    const request = responseRequest(
      "AI校閲",
      { files: "x".repeat(100000) },
      {},
    );
    await budget.reserve(
      context.budgetRunId,
      id(82),
      context.budgetArticleKey,
      "b".repeat(64),
      responsesUpperCost(request, now),
      now,
      context.deadline,
    );
    const total = Number(
      sql
        .prepare("SELECT SUM(reserved_micros) total FROM seo_budget_calls")
        .get()!.total,
    );
    expect(total).toBeLessThan(1000000);
    await expect(
      budget.reserve(
        context.budgetRunId,
        id(83),
        context.budgetArticleKey,
        "c".repeat(64),
        1000001 - total,
        now,
        context.deadline,
      ),
    ).rejects.toThrow();
  });
  it("charges longer input per pass rather than treating search context as the whole input", () => {
    const short = responseRequest("bounded", { article: "small" }, {}, true);
    const long = responseRequest(
      "bounded",
      { article: "x".repeat(60000) },
      {},
      true,
    );
    const diff =
      new TextEncoder().encode(JSON.stringify(long)).length -
      new TextEncoder().encode(JSON.stringify(short)).length;
    expect(
      responsesUpperCost(long, now) - responsesUpperCost(short, now),
    ).toBeCloseTo(diff * 4 * 0.3, 0);
    expect(() =>
      responsesUpperCost(
        responseRequest("bounded", { article: "x".repeat(128000) }, {}, true),
        now,
      ),
    ).toThrow("seo_research_bound");
  });
  it("requires a new keyword search, a discovered open page and citation; persists private evidence once", async () => {
    const evidence = await research();
    expect(evidence.sources[0].url).toBe(url);
    expect(evidence.sourceSha256).toBe(context.sourceSha256);
    expect(await research()).toEqual(evidence);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [endpoint, options] = fetchMock.mock.calls[1] as any;
    expect(endpoint).toBe("https://api.openai.com/v1/responses");
    const payload = JSON.parse(options.body);
    expect(payload).toMatchObject({
      model: "gpt-6-luna",
      store: false,
      max_tool_calls: 3,
      tool_choice: "required",
    });
    expect(payload.tools[0].external_web_access).toBe(true);
    expect(payload.text).toEqual({ format: { type: "text" } });
    expect(payload.instructions).toContain("別claimへの変更は禁止");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const expectedCost = Math.ceil(
      (128000 +
        new TextEncoder().encode(JSON.stringify(payload)).length +
        8192) *
        4 *
        0.3 +
        30000 +
        6000,
    );
    expect(responsesUpperCost(payload, now)).toBe(expectedCost);
    const call = sql
      .prepare(
        "SELECT c.* FROM seo_budget_calls c JOIN seo_editorial_checks s ON s.call_id=c.id WHERE s.phase='research'",
      )
      .get()!;
    expect(call.reserved_micros).toBe(expectedCost);
    expect(call).toMatchObject({
      run_id: context.budgetRunId,
      status: "complete",
      reserved_micros: expect.any(Number),
      month_jst: "2026-10",
    });
    expect(
      sql.prepare("SELECT deadline FROM seo_budget_runs").get()!.deadline,
    ).toBe(context.deadline);
    expect(objects.has("seo-responses/" + call.id + ".json")).toBe(true);
  });
  it.each([
    "no search",
    "no open",
    "no citation",
    "not discovered",
    "wrong claim",
    "failed open",
    "old only",
    "no sources",
    "contradiction",
    "URL query",
  ])("rejects %s instead of claiming research success", async (kind) => {
    const result = provider();
    const text: any = result.output[2];
    const value = JSON.parse(
      text.content[0].text.split("```json\n")[1].split("\n```")[0],
    );
    let body = source.content;
    if (kind === "no search") result.output.splice(0, 1);
    if (kind === "no open") result.output.splice(1, 1);
    if (kind === "no citation") text.content[0].annotations = [];
    if (kind === "not discovered")
      (result.output[0] as any).action.sources = [];
    if (kind === "wrong claim")
      value.sources[0].claimId = "Claim that is not in the original article.";
    if (kind === "failed open") result.output[1].status = "failed";
    if (kind === "old only") body += "\n" + url;
    if (kind === "no sources") value.sources = [];
    if (kind === "contradiction") value.sources[0].assessment = "contradicts";
    if (kind === "URL query") value.sources[0].url += "?private=value";
    text.content[0].text = researchText(value);
    expect(() =>
      parseResearch(result, body, context.sourceSha256, now),
    ).toThrow();
  });
  it.each([
    "plain JSON",
    "missing block",
    "trailing text",
    "multiple blocks",
    "extra field",
    "second source",
    "citation in JSON",
    "negative citation",
    "empty citation",
    "fractional citation",
    "missing offsets",
    "forged marker",
  ])("rejects malformed natural evidence: %s", (kind) => {
    const result = provider();
    const part: any = (result.output[2] as any).content[0];
    const value = JSON.parse(part.text.split("```json\n")[1].split("\n```")[0]);
    if (kind === "plain JSON") part.text = JSON.stringify(value);
    if (kind === "missing block") part.text = "Verified [1].";
    if (kind === "trailing text") part.text += "\nother";
    if (kind === "multiple blocks")
      part.text = "```json\n{}\n```\n" + part.text;
    if (kind === "extra field")
      part.text = researchText({ ...value, extra: true });
    if (kind === "second source")
      part.text = researchText({
        ...value,
        sources: [...value.sources, ...value.sources],
      });
    if (kind === "citation in JSON")
      Object.assign(part.annotations[0], { start_index: 100, end_index: 110 });
    if (kind === "negative citation") part.annotations[0].start_index = -1;
    if (kind === "empty citation") part.annotations[0].end_index = 59;
    if (kind === "fractional citation") part.annotations[0].start_index = 1.5;
    if (kind === "missing offsets") delete part.annotations[0].end_index;
    if (kind === "forged marker") part.annotations = [];
    expect(() =>
      parseResearch(result, source.content, context.sourceSha256, now),
    ).toThrow("seo_research_evidence");
  });
  it("keeps explicit insufficient rejected even with a genuine citation and support item", async () => {
    const result = provider();
    const part: any = (result.output[2] as any).content[0];
    const value = JSON.parse(part.text.split("```json\n")[1].split("\n```")[0]);
    part.text = researchText({ ...value, verdict: "insufficient" });
    fetchMock.mockImplementation(
      async (_url, options) =>
        new Response(
          JSON.stringify(
            JSON.parse(JSON.parse(options.body).input).claims
              ? plannerProvider()
              : result,
          ),
        ),
    );
    await expect(research()).rejects.toThrow("seo_research_insufficient");
    expect(budgetCount()).toBe(2);
    expect(
      sql.prepare("SELECT status FROM seo_budget_calls").get()!.status,
    ).toBe("complete");
    await expect(research()).rejects.toThrow("seo_check_conflict");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("stops when no new source exists and indexes the private paid result without retry", async () => {
    fetchMock.mockImplementation(
      async (_url, options) =>
        new Response(
          JSON.stringify(
            JSON.parse(JSON.parse(options.body).input).claims
              ? plannerProvider()
              : provider([]),
          ),
        ),
    );
    await expect(research()).rejects.toThrow("seo_research_insufficient");
    await expect(research()).rejects.toThrow("seo_check_conflict");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      sql.prepare("SELECT status FROM seo_budget_calls").get()!.status,
    ).toBe("complete");
    const index = JSON.parse(
      objects.get("seo-editorial/job/research-failure.json")!,
    );
    expect(index.responseStored).toBe(true);
    expect(objects.has(index.responseKey)).toBe(true);
  });
  it.each(["network", "incomplete", "storage"])(
    "keeps reservations for %s uncertainty",
    async (kind) => {
      if (kind === "network")
        fetchMock.mockRejectedValue(new Error("secret raw provider text"));
      if (kind === "incomplete")
        fetchMock.mockImplementation(
          async () =>
            new Response(
              JSON.stringify({ ...provider(), status: "incomplete" }),
            ),
        );
      if (kind === "storage") {
        const put = env.CMS_AI_IMAGES.put;
        env.CMS_AI_IMAGES.put = vi.fn(async (key: any, ...args: any[]) =>
          key.startsWith("seo-responses/") ? null : (put as any)(key, ...args),
        ) as any;
      }
      await expect(research()).rejects.toThrow("seo_research_call");
      expect(
        sql
          .prepare("SELECT status,reserved_micros FROM seo_budget_calls")
          .get(),
      ).toMatchObject({
        status: "unresolved",
        reserved_micros: expect.any(Number),
      });
      await expect(research()).rejects.toThrow("seo_check_conflict");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it("allows only one concurrent phase to call the provider", async () => {
    const result = await Promise.allSettled([research(), research()]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each(["run", "month"])(
    "checks the existing %s cap before search, counting held reservations",
    async (kind) => {
      const budget = new SeoBudget(env.CMS_AI_DB);
      if (kind === "run")
        await budget.reserve(
          context.budgetRunId,
          id(80),
          context.budgetArticleKey,
          "a".repeat(64),
          900000,
          now,
          context.deadline,
        );
      else
        for (let i = 2; i < 12; i++)
          await budget.reserve(
            id(i),
            id(i + 80),
            "other",
            "a".repeat(64),
            1000000,
            now,
            context.deadline,
          );
      const before = budgetCount();
      await expect(research()).rejects.toThrow("seo_research_call");
      expect(fetchMock).toHaveBeenCalledTimes(kind === "run" ? 1 : 0);
      expect(budgetCount()).toBe(before + (kind === "run" ? 1 : 0));
    },
  );
  it.each(["deadline", "terminal", "hash"])(
    "rejects %s mismatch without a new call",
    async (kind) => {
      if (kind === "deadline")
        vi.spyOn(Date, "now").mockReturnValue(context.deadline);
      if (kind === "terminal")
        sql.exec("UPDATE seo_editorial_runs SET status='unresolved'");
      if (kind === "hash") context.sourceSha256 = "b".repeat(64);
      await expect(research()).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it("cannot accept a late result after expiry and retains its paid response", async () => {
    fetchMock.mockImplementation(async () => {
      vi.spyOn(Date, "now").mockReturnValue(context.deadline);
      return new Response(JSON.stringify(provider()));
    });
    await expect(research()).rejects.toThrow();
    expect(
      sql.prepare("SELECT status FROM seo_editorial_checks").get()!.status,
    ).toBe("unresolved");
    expect(
      sql.prepare("SELECT reserved_micros FROM seo_budget_calls").get()!
        .reserved_micros,
    ).toBeGreaterThan(6000);
  });
  it("detects tampered R2 evidence and stale rates", async () => {
    await research();
    objects.set("seo-editorial/job/research.json", "{}");
    await expect(loadResearch(env, context)).rejects.toThrow();
    const request = responseRequest("instructions", {}, {}, true);
    expect(() => responsesUpperCost(request, RATE_VALID_UNTIL)).toThrow();
    expect(() =>
      responsesUpperCost({ ...request, max_tool_calls: 4 }, now),
    ).toThrow();
    expect(() =>
      responsesUpperCost(
        {
          ...request,
          tools: [{ type: "web_search", external_web_access: false }],
        },
        now,
      ),
    ).toThrow();
  });
  it.each([
    "http://docs.example.org/x",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://user:pass@docs.example.org/x",
    "https://docs.example.org/x?x=y",
    "https://docs.example.org/x#x",
  ])("rejects unsafe reference %s", (url) =>
    expect(() => referenceUrl(url)).toThrow(),
  );
});

describe("AI review gate", () => {
  async function setup() {
    await research();
    const identity = sourceIdentity(
      "cherry",
      "https://cherry.acecore.net/blog/example/",
      [source],
      now,
    )!;
    const file = {
      ...source,
      content: await acceptEditorialChange(
        identity,
        source,
        {
          ...source,
          content:
            source.content.replace("title: Original", "title: Revised") +
            "\n[Reference](" +
            url +
            ")\n",
        },
        null,
        now,
        [url],
      ),
    };
    const pass = {
      verdict: "pass",
      files: [
        {
          path: source.path,
          meaningPreserved: true,
          naturalLanguage: true,
          referencesSupported: true,
          issues: [] as string[],
        },
      ],
    };
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            id: "resp_review",
            status: "completed",
            usage: { input_tokens: 1000, output_tokens: 100 },
            output: [
              {
                type: "message",
                status: "completed",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify(pass),
                    annotations: [],
                  },
                ],
              },
            ],
          }),
        ),
    );
    return { identity, file, pass };
  }
  it("binds review to final bytes and only releases the publish gate for that hash", async () => {
    const { identity, file } = await setup();
    const receipt = await reviewArticle(
      env,
      context,
      identity,
      [source],
      [file],
      [file],
    );
    await expect(
      assertReview(env, context, receipt.filesSha256),
    ).resolves.toBeUndefined();
    await expect(assertReview(env, context, "f".repeat(64))).rejects.toThrow();
    expect(
      await reviewArticle(env, context, identity, [source], [file], [file]),
    ).toEqual(receipt);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(budgetCount()).toBe(3);
  });
  it.each([
    "否定条件が翻訳で失われている",
    "成功応答だけでなくエラー応答を確認する手順と設定漏れ発見の目的が欠落しています。",
    "Le source public は名詞と冠詞の性が一致していません。",
  ])(
    "retains review issue %s and never retries or releases publication",
    async (issue) => {
      const { identity, file, pass } = await setup();
      pass.verdict = "fail";
      pass.files[0].issues.push(issue);
      await expect(
        reviewArticle(env, context, identity, [source], [file], [file]),
      ).rejects.toThrow("seo_ai_review_failed");
      const row = sql
        .prepare("SELECT * FROM seo_editorial_checks WHERE phase='review'")
        .get()!;
      expect(row.status).toBe("unresolved");
      const index = JSON.parse(
        objects.get("seo-editorial/job/review-failure.json")!,
      );
      expect(index.callId).toBe(row.call_id);
      expect(objects.get(index.responseKey)).toContain(issue);
      await expect(
        reviewArticle(env, context, identity, [source], [file], [file]),
      ).rejects.toThrow("seo_check_conflict");
      await expect(
        assertReview(env, context, await sha256(JSON.stringify([file]))),
      ).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
  );
  it("rejects semantic edits masquerading as formatting before paying for review", async () => {
    const { identity, file } = await setup();
    await expect(
      reviewArticle(
        env,
        context,
        identity,
        [source],
        [file],
        [
          {
            ...file,
            content: file.content.replace("existing claim", "invented claim"),
          },
        ],
      ),
    ).rejects.toThrow("format_source_changed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

it("maps claim IDs to original Markdown without stripping emphasis, code or punctuation", () => {
  const body =
    "この処理では**初回だけ実行されます**。`client:load` の条件を保持します。";
  const document =
    "---\ntitle: test\n---\n\n" + body + "\n\n```js\nsecretCodeOnly()\n```\n";
  const inputs = researchInputs(document);
  expect(inputs.claims).toEqual([{ id: "claim-1", markdown: body }]);
  const evidence = parseResearch(provider(), document, "a".repeat(64));
  expect(evidence.sources[0].claim).toBe(body);
});
it("supplies existing inline, reference and plain URLs and rejects reusing them", () => {
  const document =
    source.content +
    "\n[guide][ref]\n\n[ref]: " +
    url +
    "\nhttps://docs.example.org/plain\n";
  expect(researchInputs(document).existingUrls).toEqual([
    url,
    "https://docs.example.org/plain",
  ]);
  expect(() => parseResearch(provider(), document, "a".repeat(64))).toThrow(
    "seo_research_no_new_source",
  );
});
it("rejects invented IDs and the former model-authored claim contract", () => {
  for (const change of [
    { claimId: "claim-999" },
    { claimId: 1 },
    { claimId: undefined, claim },
  ]) {
    const response = provider();
    const message = response.output[2] as any;
    const value = JSON.parse(
      message.content[0].text.split("```json\n")[1].split("\n```")[0],
    );
    Object.assign(value.sources[0], change);
    message.content[0].text = researchText(value);
    expect(() =>
      parseResearch(response, source.content, "a".repeat(64)),
    ).toThrow("seo_research_evidence");
  }
});

const fixedPlan = () =>
  parsePlan(
    {
      verdict: "ready",
      claimId: "claim-1",
      conditions: [claim],
      anchors: ["Original"],
      queries: ["Original official guide"],
    },
    source.content,
    context.sourceSha256,
  );
it("resolves exact unique quotes and retains the entire paragraph without other claims", () => {
  const plan = fixedPlan();
  expect(plan.requiredConditions).toEqual([
    { start: 0, end: claim.length, quote: claim },
  ]);
  const input = focusedInput(source.content, context.sourceSha256, plan);
  expect(input.plan.claimMarkdown).toBe(claim);
  expect(Object.keys(input)).toEqual(["plan", "existingUrls"]);
  expect(() => focusedInput(source.content, "b".repeat(64), plan)).toThrow();
  for (const override of [
    { conditions: ["invented claim statement"] },
    { anchors: ["Different"] },
    { queries: ["unrelated keyword"] },
    { claimId: "claim-99" },
  ])
    expect(() =>
      parsePlan(
        {
          verdict: "ready",
          claimId: "claim-1",
          conditions: [claim],
          anchors: ["Original"],
          queries: ["Original official guide"],
          ...override,
        },
        source.content,
        context.sourceSha256,
      ),
    ).toThrow();
  const duplicated = source.content.replace(claim, claim + " " + claim);
  expect(() =>
    parsePlan(
      {
        verdict: "ready",
        claimId: "claim-1",
        conditions: [claim],
        anchors: ["Original"],
        queries: ["Original official guide"],
      },
      duplicated,
      context.sourceSha256,
    ),
  ).toThrow();
});
it("rejects provider query rewrite and switching claim after search, including the observed shape", () => {
  const plan = fixedPlan();
  const response = provider();
  expect(() => validatePlannedSearch(response, plan)).toThrow(
    "seo_research_plan_mismatch",
  );
  (response.output[0] as any).action.queries = plan.queries;
  expect(() => validatePlannedSearch(response, plan)).not.toThrow();
  const part = (response.output[2] as any).content[0];
  const value = JSON.parse(part.text.split("```json\n")[1].split("\n```")[0]);
  value.sources[0].claimId = "claim-4";
  part.text = researchText(value);
  expect(() =>
    parseResearch(response, source.content, context.sourceSha256, now, plan),
  ).toThrow("seo_research_plan_mismatch");
});
it("persists two different call IDs and raw-response manifests, refuses an uncertain search re-entry", async () => {
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (...args) => {
    const input = JSON.parse(JSON.parse((args[1] as any).body).input);
    if (input.plan) throw new Error("lost search response");
    return original(...args);
  });
  await expect(research()).rejects.toThrow();
  const rows = sql
    .prepare(
      "SELECT phase,call_id,status FROM seo_editorial_checks ORDER BY phase",
    )
    .all();
  expect(rows.map((r) => [r.phase, r.status])).toEqual([
    ["plan", "complete"],
    ["research", "unresolved"],
  ]);
  expect(new Set(rows.map((r) => r.call_id)).size).toBe(2);
  for (const row of rows) {
    const manifest = JSON.parse(
      objects.get("seo-editorial/job/" + row.phase + "-call.json")!,
    );
    expect(manifest.callId).toBe(row.call_id);
    expect(manifest.responseKey).toBe("seo-responses/" + row.call_id + ".json");
  }
  const before = fetchMock.mock.calls.length;
  await expect(research()).rejects.toThrow("seo_check_conflict");
  expect(fetchMock).toHaveBeenCalledTimes(before);
  expect(budgetCount()).toBe(2);
});
it("stops an insufficient plan before search and preserves its private paid response", async () => {
  const result = plannerProvider();
  (result.output[0] as any).content[0].text = JSON.stringify({
    verdict: "insufficient",
    claimId: "",
    conditions: [],
    anchors: [],
    queries: [],
  });
  fetchMock.mockResolvedValue(new Response(JSON.stringify(result)));
  await expect(research()).rejects.toThrow("seo_research_insufficient");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(
    sql.prepare("SELECT phase,status FROM seo_editorial_checks").all(),
  ).toEqual([{ phase: "plan", status: "unresolved" }]);
  expect(
    JSON.parse(objects.get("seo-editorial/job/plan-failure.json")!)
      .responseStored,
  ).toBe(true);
});
it("proves 989075 microUSD for every bounded serialized request and rejects one extra byte", () => {
  const make = (search: boolean, bytes: number) => {
    const r = responseRequest("bounded", {}, search ? null : {}, search);
    r.input = "";
    r.input = "x".repeat(
      bytes - new TextEncoder().encode(JSON.stringify(r)).length,
    );
    expect(new TextEncoder().encode(JSON.stringify(r)).length).toBe(bytes);
    return r;
  };
  let total = 0;
  for (const phase of ["plan", "research", "review"] as const) {
    const request = make(phase === "research", STAGE_INPUT_BYTES[phase]);
    assertStageInput(phase, request);
    total += responsesUpperCost(request, now);
    request.input += "x";
    expect(() => assertStageInput(phase, request)).toThrow(
      "seo_stage_input_budget",
    );
  }
  const generation = {
    model: "gpt-6-luna",
    service_tier: "default",
    max_completion_tokens: 12000,
    input: "",
  };
  generation.input = "x".repeat(
    STAGE_INPUT_BYTES.generation -
      new TextEncoder().encode(JSON.stringify(generation)).length,
  );
  assertStageInput("generation", generation);
  total += 9 * upperCost("gpt-6-luna", generation, now);
  generation.input += "x";
  expect(() => assertStageInput("generation", generation)).toThrow(
    "seo_stage_input_budget",
  );
  expect(total).toBe(989075);
  expect(total).toBe(FULL_RESEARCH_RUN_MICROS);
});
it("rejects an oversized real planner input before credentials, reservation or fetch instead of truncating", async () => {
  const large = {
    ...source,
    content:
      source.content +
      "\n\n" +
      Array.from(
        { length: 40 },
        (_, i) => "Paragraph " + i + " " + "a".repeat(600),
      ).join("\n\n"),
  };
  context.sourceSha256 = await sha256(large.content);
  await expect(researchArticle(env, context, large)).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(budgetCount()).toBe(0);
});

it("does not add a planner reservation to an existing pre-upgrade search", async () => {
  sql
    .prepare(
      "INSERT INTO seo_editorial_checks(job_id,phase,call_id,input_sha256,status,created_at) VALUES(?,'research',?,?,'complete',?)",
    )
    .run(context.jobId, id(99), "a".repeat(64), now);
  await expect(research()).rejects.toThrow("seo_check_conflict");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(budgetCount()).toBe(0);
});

it("preserves pre-migration check rows and all uniqueness constraints when adding plan", () => {
  const previous = new DatabaseSync(":memory:");
  try {
    for (const file of ["0005_seo_editorial.sql", "0006_seo_research.sql"])
      previous.exec(
        readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"),
      );
    previous.exec(
      "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at) VALUES('old','budget','hash',1,'[]',0); INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index) VALUES('oldjob','old','site',0); INSERT INTO seo_editorial_checks VALUES('oldjob','research','oldcall','hash','unresolved',NULL,1)",
    );
    const before = previous.prepare("SELECT * FROM seo_editorial_checks").all();
    previous.exec(
      readFileSync(
        new URL("../migrations/0007_seo_research_plan.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(
      previous.prepare("SELECT * FROM seo_editorial_checks").all(),
    ).toEqual(before);
    previous.exec(
      "INSERT INTO seo_editorial_checks VALUES('oldjob','plan','newcall','hash','started',NULL,2)",
    );
    for (const query of [
      "INSERT INTO seo_editorial_checks VALUES('oldjob','plan','other','hash','started',NULL,2)",
      "INSERT INTO seo_editorial_checks VALUES('oldjob','review','oldcall','hash','started',NULL,2)",
      "INSERT INTO seo_editorial_checks VALUES('oldjob','other','other','hash','started',NULL,2)",
    ])
      expect(() => previous.exec(query)).toThrow();
  } finally {
    previous.close();
  }
});
it("does not send or reserve an oversized review request", async () => {
  const { seoResponse } = await import("../src/seo-responses.ts");
  await expect(
    seoResponse(env, {
      runId: context.budgetRunId,
      callId: id(88),
      articleKey: context.budgetArticleKey,
      deadline: context.deadline,
      request: responseRequest("review", { text: "x".repeat(180000) }, {}),
      phase: "review",
    }),
  ).rejects.toThrow("seo_stage_input_budget");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(budgetCount()).toBe(0);
});
it("blocks re-entry after an uncertain planner response without reserving search", async () => {
  fetchMock.mockRejectedValue(new Error("unknown"));
  await expect(research()).rejects.toThrow();
  await expect(research()).rejects.toThrow("seo_check_conflict");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(budgetCount()).toBe(1);
  expect(
    sql.prepare("SELECT phase,status FROM seo_editorial_checks").all(),
  ).toEqual([{ phase: "plan", status: "unresolved" }]);
});

it("fixes one complete exact factual sentence and retains surrounding proposals as context only", () => {
  const fact = "サービスは、招待された利用者に限り無料で参加できます。";
  const proposal = "気軽に遊びたい人におすすめです。";
  const document = source.content.replace(claim, fact + proposal);
  const plan = parsePlan(
    {
      verdict: "ready",
      claimId: "claim-1",
      targetQuote: fact,
      conditions: [fact],
      anchors: ["サービス"],
      queries: ["サービス official invitation documentation"],
    },
    document,
    context.sourceSha256,
    2,
  );
  expect(plan.target).toEqual({ start: 0, end: fact.length, quote: fact });
  expect(plan.claimMarkdown).toBe(fact + proposal);
  const response = provider();
  (response.output[0] as any).action.queries = plan.queries;
  expect(
    parseResearch(response, document, context.sourceSha256, now, plan)
      .sources[0].claim,
  ).toBe(fact);
  expect(
    focusedInput(document, context.sourceSha256, plan).plan.target!.quote,
  ).toBe(fact);
  for (const bad of [
    "無料で参加できます。",
    "サービスは、無料で参加できます。",
    fact.slice(0, -1),
    fact + proposal,
  ])
    expect(() =>
      parsePlan(
        {
          verdict: "ready",
          claimId: "claim-1",
          targetQuote: bad,
          conditions: [bad],
          anchors: ["サービス"],
          queries: ["サービス official"],
        },
        document,
        context.sourceSha256,
        2,
      ),
    ).toThrow();
  const neg = "サービスは、招待がない場合は参加できません。";
  expect(() =>
    parsePlan(
      {
        verdict: "ready",
        claimId: "claim-1",
        targetQuote: "参加できます。",
        conditions: ["参加できます。"],
        anchors: ["サービス"],
        queries: ["サービス official"],
      },
      source.content.replace(claim, neg),
      context.sourceSha256,
      2,
    ),
  ).toThrow();
});
