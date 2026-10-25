import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it, expect } from "vitest";
import { buildRetrievalRequest, parseResearch } from "../src/seo-checks.ts";
import { focusedInput } from "../src/seo-research-plan.ts";
import { sha256 } from "../src/seo-hash.ts";
import { assertStageInput } from "../src/seo-stage-budget.ts";
// Private originals stay outside Git. Logs contain only hashes and byte counts.
it.skipIf(!process.env.SEO_FOCUS_REPLAY)(
  "keeps the actual saved source, plan and insufficient response unchanged",
  async () => {
    const read = (name: string) =>
      JSON.parse(
        readFileSync(
          join(process.env.SEO_FOCUS_REPLAY!, name + ".json"),
          "utf8",
        ),
      );
    const plan = read("plan"),
      discovery = read("discovery"),
      files = read("source"),
      response = read("research-response");
    const source = files
      .find((f: any) => f.path.endsWith("/astro-i18n-blog-translation.md"))
      .content.replace(/\r\n/g, "\n");
    expect((await sha256(source)) === plan.sourceSha256).toBe(true);
    const focused = focusedInput(source, plan.sourceSha256, plan),
      old = buildRetrievalRequest(focused, discovery, "high", 2, 1),
      next = buildRetrievalRequest(focused, discovery, "high", 2, 2);
    expect(JSON.stringify(old.input) === JSON.stringify(next.input)).toBe(true);
    expect(() => assertStageInput("research", next, 2, 2)).not.toThrow();
    expect(() =>
      parseResearch(
        response,
        source,
        plan.sourceSha256,
        Date.now(),
        plan,
        discovery,
      ),
    ).toThrow("seo_research_insufficient");
    // Inspect only the final answer, never provider reasoning. These two clauses
    // reproduce the observed scope error without treating it as verified support.
    const answer = response.output
      .filter((x: any) => x.type === "message")
      .flatMap((x: any) => x.content)
      .filter((x: any) => x.type === "output_text")
      .map((x: any) => x.text)
      .join("\n");
    expect(answer.includes("glob()") && answer.includes("globstar")).toBe(true);
    expect(
      answer.includes(
        "翻訳記事を言語コードのサブディレクトリに配置するという主張",
      ) && answer.includes("文脈を含む全体の検証には不十分"),
    ).toBe(true);
    expect(plan.target.quote.includes("言語コード")).toBe(false);
    expect(plan.claimMarkdown.includes("言語コード")).toBe(true);
    console.log(
      JSON.stringify({
        sourceSha256: plan.sourceSha256,
        legacyBytes: Buffer.byteLength(JSON.stringify(old)),
        focus2Bytes: Buffer.byteLength(JSON.stringify(next)),
        sourceAndConditionsUnchanged: true,
        savedVerdict: "insufficient",
      }),
    );
  },
);
