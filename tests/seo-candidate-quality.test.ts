import { expect, it } from "vitest";
import { hasResearchableCandidate } from "../src/seo-candidate-quality.ts";
import {
  hasExternalClaimCandidate,
  plannerClaims,
} from "../src/seo-research-plan.ts";
const source = (body: string) => "---\ntitle: 制作事例\n---\n" + body;
it.each([
  "Hattは、絵や小説、VRChat向けの3D制作など、複数の創作活動を行っています。",
  "Hattの活動は、サイト内だけで完結するものではありません。",
  "Hattのホームページは、創作活動の入口として公開しました。",
  "Cloudflare Workersは、AI機能の実装に使用しています。",
  "Astro has been adopted for the portfolio site.",
  "Pagefind was integrated into the site search.",
  "AIはPlaywrightでブラウザ要素を直接操作し、JavaScriptで動作する機能を検証します。",
  "AIはまず、プロジェクトの構造を走査し、すべてのソースコードを読み込みます。",
  "CSSのレスポンシブ対応は、ビルド出力を解析する方法で代替しました。",
])(
  "rejects a product-looking subject with an own activity/deployment predicate: %s",
  (quote) => {
    expect(hasResearchableCandidate(source(quote))).toBe(false);
  },
);
it.each([
  "Cloudflare Workersは、リクエストに応じてコードを実行できます。",
  "Pagefindは、静的サイト向けの全文検索ライブラリです。",
  "Astroは、初期設定ではクライアントJavaScriptを送信しません。",
  "External product supports verified configuration settings.",
  "Pagefindは、静的サイトの検索インデックスを構築します。",
  "Cloudflare Workersは、コードの実行環境を提供しています。",
  "SQLite is implemented in the C programming language.",
])(
  "retains an independent original technical fact in a case study: %s",
  (quote) => {
    const article = source(
      "今回の制作事例ではAstroを採用しました。\n\n" + quote,
    );
    expect(hasResearchableCandidate(article)).toBe(true);
    expect(
      plannerClaims(article, 2, 2).some(
        (c) =>
          "contextParts" in c &&
          c.contextParts.some((p) => p.selectable && p.quote === quote),
      ),
    ).toBe(true);
  },
);
it("retains exact table features and all historical caveats", () => {
  const article = source(
    "旧記録です。現在の導入状況は不明です。\n\n| 製品名 | 機能 |\n| --- | --- |\n| [ExampleTool](https://example.org/tool) | リクエストの履歴をファイルに記録します。 |\n\nこの表は旧Wikiの記録です。",
  );
  expect(hasResearchableCandidate(article)).toBe(true);
  const claim = plannerClaims(article, 2, 2).find((c) => "tableContext" in c)!;
  expect(claim).toHaveProperty(
    "tableContext.precedingMarkdown",
    expect.stringContaining("現在の導入状況は不明"),
  );
  expect(claim).toHaveProperty(
    "tableContext.followingMarkdown",
    expect.stringContaining("旧Wiki"),
  );
});
it("does not reinterpret the legacy planner or infer a claim from a product name in code", () => {
  const article = source("Hattは、絵や小説などの創作活動を行っています。");
  expect(hasExternalClaimCandidate(article)).toBe(true);
  expect(hasResearchableCandidate(article)).toBe(false);
  expect(
    hasResearchableCandidate(
      source("```\nPagefindは、静的サイト向けの全文検索ライブラリです。\n```"),
    ),
  ).toBe(false);
});

// Optional private replay: originals stay outside the repository and PR.
// Set CMS_CANDIDATE_REPLAY_DIR to the parent trial directory; no network/API.
it.skipIf(!process.env.CMS_CANDIDATE_REPLAY_DIR)(
  "replays original trial 7/10/14/15 sources without printing private text",
  async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { createHash } = await import("node:crypto");
    for (const [trial, expected] of [
      [7, false],
      [10, true],
      [14, true],
      [15, false],
    ] as const) {
      const files = JSON.parse(
        readFileSync(
          join(
            process.env.CMS_CANDIDATE_REPLAY_DIR!,
            `trial-${trial}`,
            "candidate-0-files.json",
          ),
          "utf8",
        ),
      );
      const original = files[0].content;
      expect(hasExternalClaimCandidate(original)).toBe(true);
      expect(hasResearchableCandidate(original)).toBe(expected);
      const hash = createHash("sha256").update(original).digest("hex");
      console.log(
        JSON.stringify({
          trial,
          sourceSha256: hash,
          legacyCandidate: true,
          researchableCandidate: expected,
        }),
      );
    }
  },
);
