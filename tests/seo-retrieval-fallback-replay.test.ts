import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it, expect } from "vitest";
import { buildDiscoveryRequest } from "../src/seo-discovery.ts";
import { focusedInput } from "../src/seo-research-plan.ts";
import {
  externalScope,
  externalExistingUrls,
} from "../src/seo-external-sources.ts";
import { sha256 } from "../src/seo-hash.ts";
import { assertStageInput } from "../src/seo-stage-budget.ts";
import { parseResearch } from "../src/seo-checks.ts";
// Private source/response files are supplied locally, never checked into Git.
it.skipIf(!process.env.SEO_FALLBACK_REPLAY)(
  "serializes the same actual fixed source/conditions within the unchanged discovery cap",
  async () => {
    const read = (n: string) =>
      JSON.parse(
        readFileSync(
          join(process.env.SEO_FALLBACK_REPLAY!, n + ".json"),
          "utf8",
        ),
      );
    const receipt = read("rejection"),
      state = read("current-state"),
      job = state.cms.seo_editorial_jobs.find(
        (r: any) => r.id === receipt.jobId,
      ),
      files = read("source"),
      plan = read("plan"),
      discovery = read("discovery");
    const file = files.find((f: any) => f.path === job.article_path),
      source = file.content.replace(/\r\n/g, "\n");
    expect((await sha256(source)) === plan.sourceSha256).toBe(true);
    const scope = externalScope(job.site_id, {
        path: file.path,
        content: source,
      }),
      focused = {
        ...focusedInput(source, plan.sourceSha256, plan),
        existingUrls: externalExistingUrls(source, scope),
      };
    const old = buildDiscoveryRequest(focused, 5, scope, 2, 2, 2),
      next = buildDiscoveryRequest(focused, 5, scope, 2, 2, 2, 2);
    expect(old.input === next.input).toBe(true);
    expect(next.max_tool_calls).toBe(1);
    expect(() => assertStageInput("research", next, 2, 2)).not.toThrow();
    expect(discovery.fallbackUrl).toBeNull();
    expect(discovery.urls.length > 1).toBe(true);
    expect(() =>
      parseResearch(
        read("research-response"),
        source,
        plan.sourceSha256,
        Date.now(),
        plan,
        discovery,
      ),
    ).toThrow("seo_research_insufficient");
    console.log(
      JSON.stringify({
        sourceSha256: plan.sourceSha256,
        legacyBytes: Buffer.byteLength(JSON.stringify(old)),
        fallback2Bytes: Buffer.byteLength(JSON.stringify(next)),
        inputUnchanged: true,
        savedVerdict: "insufficient",
      }),
    );
  },
);
