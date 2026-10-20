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
import { SeoBudget, RATE_VALID_UNTIL } from "../src/seo-budget.ts";
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
          queries: ["existing claim official guide"],
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
    CMS_AI_MODEL: "gpt-6-luna",
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
          ? { json: async () => JSON.parse(objects.get(k)!) }
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
  fetchMock = vi.fn(async () => new Response(JSON.stringify(provider())));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  sql.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, options] = fetchMock.mock.calls[0] as any;
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
    expect(payload.instructions).toContain("主張を1つだけ");
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
    const call = sql.prepare("SELECT * FROM seo_budget_calls").get()!;
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
      async () => new Response(JSON.stringify(result)),
    );
    await expect(research()).rejects.toThrow("seo_research_insufficient");
    expect(budgetCount()).toBe(1);
    expect(
      sql.prepare("SELECT status FROM seo_budget_calls").get()!.status,
    ).toBe("complete");
    await expect(research()).rejects.toThrow("seo_check_conflict");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("stops when no new source exists and indexes the private paid result without retry", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify(provider([]))),
    );
    await expect(research()).rejects.toThrow("seo_research_insufficient");
    await expect(research()).rejects.toThrow("seo_check_conflict");
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
      if (kind === "storage")
        env.CMS_AI_IMAGES.put = vi.fn(async () => null) as any;
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
        for (let i = 2; i < 7; i++)
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
      expect(fetchMock).not.toHaveBeenCalled();
      expect(budgetCount()).toBe(before);
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
    ).toBeGreaterThan(189600);
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(budgetCount()).toBe(2);
  });
  it("retains concrete review issues through the durable call index and never retries failed review", async () => {
    const { identity, file, pass } = await setup();
    pass.verdict = "fail";
    pass.files[0].issues.push("否定条件が翻訳で失われている");
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
    expect(objects.get(index.responseKey)).toContain("否定条件");
    await expect(
      reviewArticle(env, context, identity, [source], [file], [file]),
    ).rejects.toThrow("seo_check_conflict");
    await expect(
      assertReview(env, context, await sha256(JSON.stringify([file]))),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
