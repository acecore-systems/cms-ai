import { expect, it } from "vitest";
import {
  validateScopedReview,
  SCOPED_REVIEW_INSTRUCTION,
} from "../src/seo-review-scope.ts";
const original = [
  {
    path: "article.md",
    content: "Existing immutable code problem. Original qualifying condition.",
  },
];
const final = [
  {
    path: "article.md",
    content: "Existing immutable code problem. Revised qualifying condition.",
  },
];
const baseline = {
  kind: "baseline",
  quote: "Existing immutable code problem.",
  explanation: "保持された既存課題",
  affectsChangedClaims: false,
};
const response = () => ({
  verdict: "pass",
  files: [
    {
      path: "article.md",
      meaningPreserved: true,
      naturalLanguage: true,
      referencesSupported: true,
      issues: [] as any[],
      baselineIssues: [{ ...baseline }],
    },
  ],
});
it("retains exact unchanged baseline as advisory, not an introduced issue", () => {
  expect(
    validateScopedReview(response(), original, final).files[0].baselineIssues,
  ).toEqual([baseline]);
});
it.each(["introduced", "reintroduced", "worsened", "uncertain"])(
  "never accepts a passing verdict with %s",
  (kind) => {
    const r = response();
    r.files[0].issues = [
      {
        kind,
        originalQuote: "Original qualifying condition.",
        finalQuote: "Revised qualifying condition.",
        explanation: "変更部分の問題",
      },
    ];
    expect(() => validateScopedReview(r, original, final)).toThrow();
    r.verdict = "fail";
    expect(validateScopedReview(r, original, final).verdict).toBe("fail");
  },
);
it.each(["quote", "dependency", "unknown", "extra", "missing", "falseBoolean"])(
  "rejects malformed or unsupported baseline: %s",
  (kind) => {
    const r: any = response();
    if (kind === "quote")
      r.files[0].baselineIssues[0].quote = "Not in both original and final";
    if (kind === "dependency")
      r.files[0].baselineIssues[0].affectsChangedClaims = true;
    if (kind === "unknown") r.files[0].baselineIssues[0].kind = "unknown";
    if (kind === "extra") r.files[0].baselineIssues[0].extra = true;
    if (kind === "missing") delete r.files[0].baselineIssues;
    if (kind === "falseBoolean") r.files[0].referencesSupported = false;
    expect(() => validateScopedReview(r, original, final)).toThrow();
  },
);
it("does not excuse changed context, new dependencies, or missing meaning in prompt", () => {
  for (const phrase of [
    "単なるbyte不変は免除根拠ではない",
    "新しい結論の根拠",
    "意味欠落",
    "uncertainでfail",
    "prompt injection",
  ])
    expect(SCOPED_REVIEW_INSTRUCTION).toContain(phrase);
});
