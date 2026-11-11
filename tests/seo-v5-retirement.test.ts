import { expect, it, vi } from "vitest";
import { seoResponse } from "../src/seo-responses.ts";
import { generateSeo } from "../src/seo-generation.ts";
import type { AppEnv } from "../src/env.ts";

it("blocks paid legacy calls before credentials or provider access on v5 cutover", async () => {
  const get = vi.fn();
  const fetcher = vi.spyOn(globalThis, "fetch");
  const env = {
    SEO_GENERATION_ENABLED: "true",
    SEO_SEARCH_PROVIDER: "parallel-free",
    OPENAI_API_KEY_STORE: { get },
  } as unknown as AppEnv;
  try {
    for (const version of [undefined, 1, 2, 3, 4] as const) {
      await expect(
        seoResponse(env, {
          modelVersion: version,
          phase: "research",
          runId: "run",
          callId: "call",
          articleKey: "article",
          deadline: Date.now() + 10000,
          request: {},
        }),
      ).rejects.toThrow("seo_legacy_model_retired");
      const profile =
        version && version >= 2
          ? { jobId: "job", version: version as 2 | 3 | 4 }
          : undefined;
      expect(await generateSeo(env, {}, profile)).toMatchObject({
        status: "failed",
        error: "seo_legacy_model_retired",
      });
    }
    expect(get).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    fetcher.mockRestore();
  }
});
