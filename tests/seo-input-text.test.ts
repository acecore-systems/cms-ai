import { describe, expect, it } from "vitest";
import { shareText, expandSharedText } from "../src/seo-input-text.ts";
import { buildReviewRequest } from "../src/seo-checks.ts";
import { buildEditorialInstruction } from "../src/seo-editorial-instruction.ts";
import { SEO_WRITING_GUIDE } from "../src/seo-editorial-guide.ts";
import { sourceIdentity } from "../src/seo-content.ts";
import { SEO_LOCALES } from "../src/sites.ts";
import {
  assertStageInput,
  FULL_RESEARCH_RUN_MICROS,
} from "../src/seo-stage-budget.ts";
import { responsesUpperCost } from "../src/seo-responses.ts";
const evidence = {
  version: 1 as const,
  checkedAt: "2026-10-22T00:00:00Z",
  sourceSha256: "a".repeat(64),
  responseId: "fixture",
  queries: ["fixture"],
  sources: [],
};
const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
describe("lossless SEO input sharing", () => {
  it("preserves CRLF, fences, whitespace, empty files, EOF and literal fake refs", () => {
    const text =
      '---\r\ntitle: Example\r\n---\r\n\r\n```\r\n{"ref":"text0"}\r\n  protected  \r\n```\r\n\r\n' +
      "Do not remove this condition. ".repeat(20);
    const files = [
      { path: "a", content: text },
      { path: "b", content: text },
      { path: "c", content: "" },
      { path: "d", content: text + "\n" },
    ];
    const packed = shareText(files);
    expect(expandSharedText(JSON.parse(JSON.stringify(packed)))).toEqual(files);
    expect(size(packed)).toBeLessThan(size(files));
    expect(() =>
      expandSharedText({
        shared: {},
        files: [{ path: "x", parts: [{ ref: "missing" }] }],
      }),
    ).toThrow("seo_input_reference");
  });
  it("does not equate negation, dates, URLs, whitespace or code fence language", () => {
    const variants = [
      "enabled",
      "not enabled",
      "2025",
      "2026",
      "https://example.org/a",
      "https://example.org/b",
      "```\ncode\n```",
      "```text\ncode\n```",
      "x  y",
      "x y",
    ];
    const files = variants.map((content, i) => ({ path: String(i), content }));
    expect(expandSharedText(shareText(files))).toEqual(files);
    expect(shareText(files).shared).toEqual({});
  });
  it("roundtrips deterministic mixed scripts and malformed markdown without parsing it", () => {
    for (let i = 0; i < 40; i++) {
      const text =
        ("日本語 FR français 한국어 🚀 " + i + "\r\n\r\n").repeat(i) +
        "unterminated ```\n";
      const files = [
        { path: "a", content: text },
        { path: "b", content: text + "\n\nend" },
      ];
      expect(expandSharedText(shareText(files))).toEqual(files);
    }
  });
  it("keeps all 9 original/final texts, full guides, evidence and quality schema", () => {
    const path = "src/content/stories/example.md";
    const originals = [
      {
        path,
        content:
          "---\ntitle: Example\ndate: 2026-10-01\n---\n\nExisting condition.\n",
      },
      ...SEO_LOCALES.map((locale) => ({
        path: `src/content/stories/${locale}/example.md`,
        content: `---\ntitle: ${locale}\ndate: 2026-10-01\n---\n\nExisting condition.\n`,
      })),
    ];
    const identity = sourceIdentity(
      "portal",
      "https://asv.acecore.net/stories/example/",
      originals,
    )!;
    const guide = {
      path: "docs/guide.md",
      content: "Never omit success AND error checks.\n",
    };
    const final = originals.map((f) => ({
      ...f,
      content: f.content + "\nChanged explanation.\n",
    }));
    const request = buildReviewRequest(
      identity,
      [...originals, guide],
      final,
      evidence,
    );
    const input = JSON.parse(request.input);
    expect(
      expandSharedText({ shared: input.shared, files: input.originals }),
    ).toEqual(originals);
    expect(
      expandSharedText({ shared: input.shared, files: input.files }),
    ).toEqual(final);
    expect(
      expandSharedText({ shared: input.shared, files: input.guides }),
    ).toEqual([guide]);
    expect(input.writingGuide).toBe(SEO_WRITING_GUIDE);
    expect(input.evidence).toEqual(evidence);
    expect(input.locales).toHaveLength(9);
    expect(request.instructions).toContain("問題や確認不能が1つでもあればfail");
    expect(request.text.format.schema.properties.files.items.required).toEqual([
      "path",
      "meaningPreserved",
      "naturalLanguage",
      "referencesSupported",
      "issues",
    ]);
    expect(request.instructions).toContain(
      "including unchanged referenced parts",
    );
    expect(
      responsesUpperCost(request, Date.parse("2026-10-22T00:00:00Z")),
    ).toBe(Math.ceil((size(request) + 8192) * 0.3 + 6000));
    const inflated = final.map((f, i) => ({
      ...f,
      content: `unique revision ${i} `.repeat(13000),
    }));
    expect(() =>
      assertStageInput(
        "review",
        buildReviewRequest(identity, originals, inflated, evidence),
      ),
    ).toThrow("seo_stage_input_budget");
    expect(FULL_RESEARCH_RUN_MICROS).toBe(989075);
  });
  it("retains researched generation quality and clarification constraints without dropping guide/evidence", () => {
    const instruction = buildEditorialInstruction({
      step: 1,
      paths: ["ja.md", "fr.md"],
      locale: "fr",
      translationCount: 8,
      reason: "fixture",
      research: evidence,
    });
    for (const required of [
      "1 call = 1 file",
      "one budget run ID and absolute deadline",
      "before one Draft PR",
      "paired success/error checks",
      "subjects, scope, order and reasons",
      "noun gender/number",
      "subject-verb agreement",
      "manuscript versus code",
      "changes=[]",
      "no Japanese fragments",
      "byte-for-byte",
      "controller alone sets sourceHash",
      "every locale",
      "separate AI reviewer decides",
    ])
      expect(instruction).toContain(required);
    expect(instruction).toContain(SEO_WRITING_GUIDE);
    expect(instruction).toContain(JSON.stringify(evidence));
    const old = buildEditorialInstruction({
      step: 0,
      paths: ["ja.md"],
      translationCount: 8,
      reason: "fixture",
      research: null,
    });
    expect(old).toContain("外部参考資料は今回未取得");
  });
});
