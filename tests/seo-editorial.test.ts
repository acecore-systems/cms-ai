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
const now = Date.parse("2026-10-19T00:00:00Z");
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
  for (const migration of ["0004_seo_budget.sql", "0005_seo_editorial.sql"])
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
  it("runs all nine copy changes under one absolute budget deadline and only reports a Draft PR", async () => {
    const jobId = await claimed();
    expect(claim).toHaveBeenCalledWith({
      runId,
      articleKey: "portal:" + sourcePath,
      sourceSha256: await sha256(files[0].content),
    });
    let japanese = "";
    for (let step = 0; step < 9; step++) {
      const response = await request(jobId, "propose", {
        step,
        ...(step === 1 ? { japanese } : {}),
      });
      expect(response.status).toBe("proposal_created");
      if (step === 0) japanese = response.file.content;
      else
        expect(response.file.content).toContain(
          "sha256:" + (await sha256(japanese)),
        );
    }
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
