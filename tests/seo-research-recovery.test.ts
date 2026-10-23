import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { format } from "prettier";
import { externalScope } from "../src/seo-external-sources.ts";
import {
  buildPlanRequest,
  buildRetrievalRequest,
  parseResearch,
} from "../src/seo-checks.ts";
import {
  buildDiscoveryRequest,
  parseDiscovery,
  assertDiscovery,
} from "../src/seo-discovery.ts";
import {
  researchInputs,
  plannerClaims,
  parsePlan,
  focusedInput,
  hasExternalClaimCandidate,
} from "../src/seo-research-plan.ts";
import {
  tableClaims,
  assertTableContextPreserved,
} from "../src/seo-table-claims.ts";
import { sha256 } from "../src/seo-hash.ts";
import { responsesUpperCost, responseRequest } from "../src/seo-responses.ts";
import {
  stageBudget,
  assertStageInput,
  allocateGenerationInputs,
} from "../src/seo-stage-budget.ts";
import { upperCost } from "../src/seo-budget.ts";

const historical =
  "この一覧は旧Wikiから引き継いだ記録です。**現在も各プラグインが導入されていることを示すものではありません。**\n\n## 旧Wikiのプラグイン一覧\n\n";
const row =
  "| [CoreProtect](https://www.spigotmc.org/resources/coreprotect.8631/) | ブロックの設置や破壊などのログを記録します。 |";
const source = {
  path: "poc/astro-sveltia/src/content/wiki/plugins.md",
  content:
    "---\ntitle: プラグイン一覧\n---\n" +
    historical +
    "| 旧Wikiに記載されたプラグイン名 | 旧Wikiで説明された機能 |\n| --- | --- |\n" +
    row +
    "\n| [LuckPerms](https://luckperms.net/) | コマンド権限を管理します。 |\n",
};
const first = "https://docs.example.org/primary",
  second = "https://docs.example.org/alternative";
const now = Date.parse("2026-10-23T00:00:00Z");
async function fixture() {
  const hash = await sha256(source.content),
    scope = externalScope("aceserver-wiki", source);
  const c = tableClaims(source.content)[0];
  const value = {
    verdict: "ready",
    claimId: c.id,
    targetQuote: c.markdown,
    conditions: [c.tableContext.featureMarkdown],
    anchors: ["CoreProtect"],
    queries: ["CoreProtect official block logging"],
  };
  const plan = parsePlan(value, source.content, hash, 2, 2);
  const response: any = {
    id: "resp_discovery",
    status: "completed",
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: {
          type: "search",
          queries: plan.queries,
          sources: [first, second].map((url) => ({ type: "url", url })),
        },
      },
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            annotations: [],
            text: JSON.stringify({
              verdict: "selected",
              selectedUrl: first,
              fallbackUrl: second,
              reason:
                "Two independently relevant primary candidates; snippets unverified",
            }),
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(response);
  const discovery = await parseDiscovery(
    response,
    source.content,
    plan,
    raw,
    5,
    scope,
    2,
  );
  return {
    hash,
    scope,
    value,
    plan,
    response,
    raw,
    discovery,
    focused: focusedInput(source.content, hash, plan),
  };
}
function retrieved(fallback = true) {
  const url = fallback ? second : first;
  return {
    id: "resp_research",
    status: "completed",
    output: [
      ...[first, ...(fallback ? [second] : [])].map((url) => ({
        type: "web_search_call",
        status: "completed",
        action: { type: "open_page", url },
      })),
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text:
              "Product logging capability is supported [1].\n```json\n" +
              JSON.stringify({
                verdict: "verified",
                sources: [
                  {
                    url,
                    title: "Primary docs",
                    claimId: "table-claim-1",
                    excerpt:
                      "CoreProtect records block placements and block breaks in a log.",
                    assessment: "supports",
                  },
                ],
                retrieval: [
                  {
                    url: first,
                    outcome: fallback ? "unavailable" : "retrieved",
                  },
                  ...(fallback ? [{ url: second, outcome: "retrieved" }] : []),
                ],
              }) +
              "\n```",
            annotations: [
              { type: "url_citation", url, start_index: 39, end_index: 42 },
            ],
          },
        ],
      },
    ],
  };
}
function rewrite(result: any, action: (value: any) => void) {
  const part = result.output.at(-1).content[0],
    value = JSON.parse(part.text.split("```json\n")[1].split("\n```")[0]);
  action(value);
  part.text =
    "Product logging capability is supported [1].\n```json\n" +
    JSON.stringify(value) +
    "\n```";
}
it("keeps legacy paragraph IDs/offsets and permits tables only in the new frozen plan", async () => {
  const f = await fixture();
  expect(plannerClaims(source.content, 2)).not.toEqual(
    plannerClaims(source.content, 2, 2),
  );
  expect(
    researchInputs(source.content).claims.every((c) =>
      c.id.startsWith("claim-"),
    ),
  ).toBe(true);
  expect(() => parsePlan(f.value, source.content, f.hash, 2)).toThrow(
    "seo_research_plan_invalid",
  );
  expect(f.plan.version).toBe(3);
  expect(f.plan.target?.quote).toBe(row);
  expect(f.plan.tableContext?.precedingMarkdown).toBe(historical);
  expect(f.plan.tableContext?.headerMarkdown).toContain(
    "旧Wikiで説明された機能",
  );
  expect(() => focusedInput(source.content, f.hash, f.plan)).not.toThrow();
  for (const field of [
    "precedingMarkdown",
    "followingMarkdown",
    "headerMarkdown",
    "subjectMarkdown",
    "featureMarkdown",
  ] as const) {
    const tampered = structuredClone(f.plan);
    tampered.tableContext![field] += "changed";
    expect(() => focusedInput(source.content, f.hash, tampered)).toThrow(
      "seo_research_plan_mismatch",
    );
  }
  expect(() =>
    parsePlan(
      { ...f.value, conditions: ["ブロックの設置や破壊などのログ"] },
      source.content,
      f.hash,
      2,
      2,
    ),
  ).toThrow();
  expect(() =>
    parsePlan(
      { ...f.value, anchors: ["ブロック"] },
      source.content,
      f.hash,
      2,
      2,
    ),
  ).toThrow();
});
it("rejects deployment claims, announcements, instructions and resource navigation without article blacklists", () => {
  for (const paragraph of [
    "エースサーバーはJava版・統合版のどちらでも遊べる公開サーバーです。",
    "エースサーバーには、参加前に確認したい情報が複数あります。",
    "ポータルはAstroとTailwind CSS v4を使った静的サイトです。ページ本文やサイト設定はSveltia CMSから更新できます。",
    "[IPAの中小企業の情報セキュリティ対策ガイドライン](https://www.ipa.go.jp/security/guide/sme/about.html)は、ITの課題を整理する際の参考資料です。",
    "[Scratch Foundationの学習リソース](https://www.scratchfoundation.org/learn)：家庭で試せる創作活動を探したいときに。",
    "MOBを過剰に増やさないでください。状況に応じて運営がMOBを削除する場合があります。",
  ]) {
    const article = "---\ntitle: Any title\n---\n" + paragraph;
    expect(hasExternalClaimCandidate(article), paragraph).toBe(false);
    expect(
      plannerClaims(article, 2, 2)
        .flatMap((c: any) => c.contextParts)
        .some((p: any) => p.selectable),
    ).toBe(false);
  }
  expect(
    hasExternalClaimCandidate(
      "---\ntitle: Technical\n---\nCoreProtectはブロックの設置や破壊のログを記録します。",
    ),
  ).toBe(true);
  expect(hasExternalClaimCandidate(source.content)).toBe(true);
});
it("preserves history, header and functionality through Japanese revision and formatting, rejects current-deployment conversion", async () => {
  const context = tableClaims(source.content)[0].tableContext;
  const revised = source.content + "\n[Primary docs](" + second + ")\n";
  expect(() => assertTableContextPreserved(context, revised)).not.toThrow();
  expect(() =>
    assertTableContextPreserved(
      context,
      source.content.replace("示すものではありません", "示しています"),
    ),
  ).toThrow();
  expect(() =>
    assertTableContextPreserved(
      context,
      source.content.replace("旧Wikiで説明された機能", "現在提供している機能"),
    ),
  ).toThrow();
  expect(() =>
    assertTableContextPreserved(
      context,
      source.content.replace("ログを記録します", "ログを記録しません"),
    ),
  ).toThrow();
  // Formatting is validated as a GFM table, not a paragraph of pipe characters.
  const formatted = await format(revised, { parser: "markdown" });
  expect(() => assertTableContextPreserved(context, formatted)).not.toThrow();
});
it("rejects unsafe, self, existing, rewritten, duplicate and non-search fallback URLs", async () => {
  const f = await fixture();
  for (const bad of [
    first,
    "https://docs.example.org/invented",
    "http://127.0.0.1/",
    "https://asv-wiki.acecore.net/",
    "https://luckperms.net/",
  ]) {
    const response = structuredClone(f.response);
    response.output[1].content![0].text = JSON.stringify({
      verdict: "selected",
      selectedUrl: first,
      fallbackUrl: bad,
      reason: "candidate",
    });
    await expect(
      parseDiscovery(
        response,
        source.content,
        f.plan,
        JSON.stringify(response),
        5,
        f.scope,
        2,
      ),
    ).rejects.toThrow();
  }
  await expect(
    assertDiscovery(
      { ...f.discovery, fallbackUrl: "https://docs.example.org/invented" },
      source.content,
      f.plan,
      f.raw,
      f.scope,
    ),
  ).rejects.toThrow();
  const request = buildRetrievalRequest(f.focused, f.discovery, "high", 2);
  expect(request.max_tool_calls).toBe(2);
  expect(JSON.parse(request.input).discovery.retrievalUrls).toEqual([
    first,
    second,
  ]);
});
it.each([false, true])(
  "accepts only one opened/cited source, with ordered unavailable-only fallback=%s",
  async (fallback) => {
    const f = await fixture(),
      result = retrieved(fallback);
    const evidence = parseResearch(
      result,
      source.content,
      f.hash,
      now,
      f.plan,
      f.discovery,
    );
    expect(evidence.sources[0].url).toBe(fallback ? second : first);
    expect(evidence.sources[0].claim).toBe(row);
    expect(evidence.tableContext).toEqual(f.plan.tableContext);
  },
);
it.each([
  "retrieved-first",
  "contradicts",
  "insufficient-first",
  "reverse",
  "third-open",
  "search",
  "unopened",
  "uncited-snippet",
  "cross-citation",
  "mismatch-outcome",
  "unavailable-final",
  "different-claim",
])("rejects fallback evidence confusion: %s", async (kind) => {
  const f = await fixture(),
    result: any = retrieved();
  if (
    kind === "retrieved-first" ||
    kind === "contradicts" ||
    kind === "insufficient-first"
  )
    rewrite(
      result,
      (v) =>
        (v.retrieval[0].outcome =
          kind === "retrieved-first" ? "retrieved" : kind),
    );
  if (kind === "reverse")
    [result.output[0], result.output[1]] = [result.output[1], result.output[0]];
  if (kind === "third-open")
    result.output.unshift(structuredClone(result.output[0]));
  if (kind === "search")
    result.output[0].action = {
      type: "search",
      queries: f.plan.queries,
      sources: [{ url: second }],
    };
  if (kind === "unopened")
    rewrite(
      result,
      (v) => (v.sources[0].url = "https://docs.example.org/third"),
    );
  if (kind === "uncited-snippet")
    result.output.at(-1).content[0].annotations = [];
  if (kind === "cross-citation")
    result.output.at(-1).content[0].annotations[0].url = first;
  if (kind === "mismatch-outcome")
    rewrite(result, (v) => (v.retrieval[0].url = second));
  if (kind === "unavailable-final")
    rewrite(result, (v) => (v.retrieval[1].outcome = "unavailable"));
  if (kind === "different-claim")
    rewrite(result, (v) => (v.sources[0].claimId = "table-claim-2"));
  expect(() =>
    parseResearch(result, source.content, f.hash, now, f.plan, f.discovery),
  ).toThrow();
});
it("proves every serialized request and all nine full locale caps fit 1249533 microUSD in 13 API calls", async () => {
  const f = await fixture(),
    caps = stageBudget(2, 2);
  const fill = (r: any, n: number) => {
    r.padding = "";
    r.padding = "x".repeat(n - Buffer.byteLength(JSON.stringify(r)));
    expect(Buffer.byteLength(JSON.stringify(r))).toBe(n);
    return r;
  };
  const requests = [
    buildPlanRequest(source.content, 2, 5, f.scope, 2),
    buildDiscoveryRequest(f.focused, 5, f.scope, 2, 2),
    buildRetrievalRequest(f.focused, f.discovery, "high", 2),
    responseRequest("review", {}, {}),
  ];
  const stages = ["plan", "research", "research", "review"] as const;
  requests.forEach((r, i) => assertStageInput(stages[i], r, 2, 2));
  const padded = requests.map((r, i) => fill(r, caps.limits[stages[i]]));
  const allocations = allocateGenerationInputs(
    Array.from({ length: 9 }, (_, i) => ({ path: `${i}.md`, bytes: 40000 })),
    2,
    2,
  );
  const generation = allocations.map((a) =>
    fill(
      { service_tier: "default", max_completion_tokens: 12000, messages: [] },
      a.maxBytes,
    ),
  );
  const total =
    padded.reduce((n, r) => n + responsesUpperCost(r, now, 2), 0) +
    generation.reduce((n, r) => n + upperCost("gpt-6-luna", r, now), 0);
  expect(total).toBe(caps.maximum);
  expect(total).toBe(1249533);
  expect(total).toBeLessThanOrEqual(1250000);
  expect(padded.length + generation.length).toBe(13);
  expect(allocations.reduce((n, a) => n + a.maxBytes, 0)).toBe(525000);
  expect(() => responsesUpperCost(padded[2], now)).toThrow();
  expect(() =>
    assertStageInput("research", { text: "x".repeat(8000) }, 2, 2),
  ).toThrow();
  expect(stageBudget(2).maximum).toBe(1205876);
});
it("migration preserves every legacy row/column and prior locks/budget triggers with immutable default 1", () => {
  const db = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(migrations)
    .filter((f) => /^\d+_seo/.test(f) && f < "0022")
    .sort())
    db.exec(readFileSync(new URL(filename, migrations), "utf8"));
  db.exec(
    "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at) VALUES('old','budget','hash',1,'[]',0);INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index) VALUES('oldjob','old','site',0)",
  );
  const before = db.prepare("SELECT * FROM seo_editorial_jobs").get()!;
  const triggers = db
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
    )
    .all();
  db.exec(
    readFileSync(new URL("0022_seo_research_recovery.sql", migrations), "utf8"),
  );
  expect(db.prepare("SELECT * FROM seo_editorial_jobs").get()).toEqual({
    ...before,
    research_recovery: 1,
  });
  expect(
    db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name!='seo_research_recovery_immutable' ORDER BY name",
      )
      .all(),
  ).toEqual(triggers);
  expect(() =>
    db.exec("UPDATE seo_editorial_jobs SET research_recovery=2"),
  ).toThrow("immutable_research_recovery");
  db.close();
});

it("retains trailing qualifications and rejects ambiguous subject anchors and non-feature tables", async () => {
  const suffix =
    "\n\nこの機能は旧版だけの説明で、現行の利用可能性は未確認です。\n";
  const original = source.content + suffix,
    c = tableClaims(original)[0];
  expect(c.tableContext.followingMarkdown).toBe("\n" + suffix);
  expect(() =>
    assertTableContextPreserved(
      c.tableContext,
      original.replace("未確認です", "確認済みです"),
    ),
  ).toThrow();
  expect(
    tableClaims(
      source.content.replace("旧Wikiで説明された機能", "現在の導入状況"),
    ),
  ).toEqual([]);
  expect(
    tableClaims(source.content.replaceAll("CoreProtect", "coreprotect")).some(
      (c) => c.tableContext.subjectMarkdown.includes("coreprotect"),
    ),
  ).toBe(false);
  const f = await fixture(),
    request = buildPlanRequest(source.content, 2, 5, f.scope, 2);
  expect(request.instructions).toContain("conditionsは[featureMarkdown全文]");
  expect(request.instructions).toContain("リンク表示の製品名exactを必須");
});
