import { SITES } from "../src/sites.ts";
import { STAGE_INPUT_BYTES } from "../src/seo-stage-budget.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateSeo,
  generationReadiness,
  buildSeoGenerationRequest,
} from "../src/seo-generation.ts";
import type { AppEnv } from "../src/env.ts";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("SEO generation gate", () => {
  it("reserves before inference and saves the bounded proposal without dispatch", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-19T00:00:00Z"));
    const order: string[] = [];
    const statement = {
      bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }),
    };
    const result = {
      changes: [
        {
          path: "src/content/blog/example.md",
          content: "revised",
          reason: "verified source",
        },
      ],
      clarification: "",
      summary: "proposal",
    };
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).reasoning_effort).toBe("high");
      const predicted = buildSeoGenerationRequest(
        SITES.find((s) => s.id === "homepage-hatt")!,
        "src/content/blog/example.md",
        ["src/content/blog/example.md"],
        "参考資料に基づき改訂案を作成",
        [{ path: "src/content/blog/example.md", content: "original" }],
      );
      expect(String(init.body)).toBe(JSON.stringify(predicted));
      order.push("inference");
      return Response.json({
        choices: [{ message: { content: JSON.stringify(result) } }],
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const env = {
      SEO_GENERATION_ENABLED: "true",
      CMS_AI_MODEL: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
      SEO_AI_MODEL: "gpt-6-luna",
      OPENAI_API_KEY_STORE: { get: async () => "fixture-key" },
      CMS_AI_DB: {
        prepare: () => statement,
        batch: async () => {
          order.push("reserve");
          return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
        },
      },
      CMS_AI_IMAGES: {
        put: async () => {
          order.push("saved");
          return {};
        },
      },
    } as unknown as AppEnv;
    const response = await generateSeo(env, {
      runId: "seo-00000000-0000-4000-8000-000000000001",
      callId: "seo-00000000-0000-4000-8000-000000000002",
      siteId: "homepage-hatt",
      articlePath: "src/content/blog/example.md",
      allowedPaths: ["src/content/blog/example.md"],
      instruction: "参考資料に基づき改訂案を作成",
      files: [{ path: "src/content/blog/example.md", content: "original" }],
    });
    expect(response.status).toBe("proposal_created");
    expect(order).toEqual(["reserve", "inference", "saved"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps generation disabled without the explicit flag", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const env = {} as AppEnv;
    expect(await generateSeo(env, { arbitrary: "input" })).toEqual({
      status: "disabled",
    });
    expect(generationReadiness(env).budget).toMatchObject({
      runMicros: 1_000_000,
      monthMicros: 7_000_000,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects unregistered or extra input without an API call", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      await generateSeo({ SEO_GENERATION_ENABLED: "true" } as AppEnv, {
        siteId: "unregistered",
        ownerApproved: true,
      }),
    ).toMatchObject({ status: "stopped", stage: "validation" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it("rejects oversized v2 generation before reserve/fetch without truncation", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-20T00:00:00Z"));
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const batch = vi.fn();
  const env = {
    SEO_GENERATION_ENABLED: "true",
    CMS_AI_MODEL: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
    SEO_AI_MODEL: "gpt-6-luna",
    OPENAI_API_KEY_STORE: { get: async () => "fixture" },
    CMS_AI_DB: { batch },
  } as unknown as AppEnv;
  const response = await generateSeo(env, {
    runId: "seo-00000000-0000-4000-8000-000000000001",
    callId: "seo-00000000-0000-4000-8000-000000000002",
    siteId: "homepage-hatt",
    articlePath: "src/content/blog/example.md",
    allowedPaths: ["src/content/blog/example.md"],
    instruction: "Revise with evidence",
    files: [
      {
        path: "src/content/blog/example.md",
        content: "x".repeat(STAGE_INPUT_BYTES.generation),
      },
    ],
    researchBudget: true,
  });
  expect(response).toMatchObject({ status: "stopped", stage: "budget" });
  expect(batch).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["exact", "one-byte-over", "legacy"])(
  "enforces persisted locale cap against actual provider bytes: %s",
  async (kind) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-22T00:00:00Z"));
    const path = "src/content/blog/example.md",
      files = [{ path, content: "original ".repeat(5500) }];
    const instruction = "Preserve every source byte while improving prose";
    const predicted = buildSeoGenerationRequest(
      SITES.find((s) => s.id === "homepage-hatt")!,
      path,
      [path],
      instruction,
      files,
    );
    const bytes = Buffer.byteLength(JSON.stringify(predicted));
    expect(bytes).toBeGreaterThan(45000);
    const fetcher = vi.fn(async (_url, init) => {
      expect(init.body).toBe(JSON.stringify(predicted));
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                changes: [
                  { path, content: files[0].content, reason: "fixture" },
                ],
                summary: "fixture",
                clarification: "",
              }),
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const batch = vi.fn(async () => [
      { meta: { changes: 1 } },
      { meta: { changes: 1 } },
    ]);
    const env = {
      SEO_GENERATION_ENABLED: "true",
      SEO_AI_MODEL: "gpt-6-luna",
      OPENAI_API_KEY_STORE: { get: async () => "fixture" },
      CMS_AI_DB: {
        batch,
        prepare: () => ({
          bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }),
        }),
      },
      CMS_AI_IMAGES: { put: async () => ({}) },
    } as unknown as AppEnv;
    const result = await generateSeo(env, {
      runId: "seo-00000000-0000-4000-8000-000000000001",
      callId: "seo-00000000-0000-4000-8000-000000000002",
      siteId: "homepage-hatt",
      articlePath: path,
      allowedPaths: [path],
      instruction,
      files,
      researchBudget: true,
      ...(kind === "legacy"
        ? {}
        : { generationInputCap: bytes - (kind === "one-byte-over" ? 1 : 0) }),
    });
    expect(result.status).toBe(
      kind === "exact" ? "proposal_created" : "stopped",
    );
    expect(batch).toHaveBeenCalledTimes(kind === "exact" ? 1 : 0);
    expect(fetcher).toHaveBeenCalledTimes(kind === "exact" ? 1 : 0);
  },
);
