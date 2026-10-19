# クラウド週次SEOのDraft PR経路

通常CMSの`runner@v1`、ユーザーrole、会話、編集経路は維持する。SEOは独立したService Binding、OIDC audience、workflow、D1 state、actionを使い、確認済みDraft PRだけを結果として返す。実際の記事生成・dispatch・統合・公開は、この実装PRの受入後に別途確認する。

## 親SEOとの契約

CMSのnamed entrypointは`SeoEditorial`。HTTP fetchは404とし、Service Bindingでのみ開始・status照会できる。

```ts
start({
  runId: string, // editorial-UUID / manual-UUID / weekly-YYYY-MM-DD
  deadline: number, // UTC epoch milliseconds、受付から最大30分の絶対期限
  candidates: Array<{ site: string; url: string; reason?: string }>, // 0〜3件
});
// {status:'started'|'stopped'|'unresolved', jobId?:string}

status({ runId: string });
// {status:'pending'|'draft_pr'|'no_eligible_article'|'unresolved',
//  articleKey?:string, prUrl?:string}
```

`site`は`hatt/cherry/corporate/systems/portal/wiki`または対応する既存CMS site ID。同一runの入力は固定し、外部IDと一意な内部`seo-UUID`予算run IDをD1へ永続対応付けする。重複startはdispatchしない。候補0件・全件非記事は永続`no_eligible_article`となる。

CMSから親へのbindingは`SEO_COORDINATOR`、serviceは`acecore-seo-ops`、entrypointは`SeoCoordinator`。

```ts
claim({ runId, articleKey, sourceSha256 });
// {status:'claimed'|'denied'}
complete({ runId, articleKey, status: "draft_pr", prUrl });
complete({ runId, articleKey, status: "unresolved" });
// {status:'recorded'|'denied'}
```

articleKeyは必ず`site:日本語正本path`。`articleId`は変更しないmetadataでありlock keyに使わない。sourceSha256は改訂前の日本語全文をLF正規化した64桁hex。source・現在main SHA・open PRのfile overlapを検査してから、生成前にclaimする。claimの応答が不明なら別候補へ進まない。claim拒否・記事/locale不足・overlapは未編集の候補として次へ進め、最大3件まで順次検査する。

callbackは既存claimの結果記録だけに使う。`unresolved`にprUrlは付けず、`draft_pr`には必須。`no_eligible_article`にcallbackはない。callbackの応答不明時はstatus照会で同じ内容だけを再送する。dispatch、生成、PR作成の不明結果は自動再送しない。期限後は新しい編集を開始せず、既に作成して確認できたPRのfinish/callbackだけを受け付ける。

## 対象サイトのworkflow

[template](../integration/seo-content.yml)を各対象repoの`.github/workflows/seo-content.yml`へ設置する。workflow inputは必須stringの`run_id`と`job_id`のみ。mainをcheckoutし、Node 24、対象package directoryの`npm ci`を経て、`acecore-systems/cms-ai/seo-runner@40桁の検証済みcommit SHA`を呼ぶ。action inputは`run-id`と`job-id`。Wikiのpackage directoryは`poc/astro-sveltia`。

OIDC audienceとHTTP基点は`https://cms-ai.acecore.net/seo-runner`。登録済みrepository、`workflow_dispatch`、`refs/heads/main`、`seo-content.yml@refs/heads/main`、初回run attempt、workflow commit SHAを照合し、jobを最初のGitHub run IDへ束縛する。通常CMSのaudience・workflowはこの経路を使えない。

CMS Appは既存の`actions:write`だけを使う。サイトsourceのread、PR一覧の完全なページング、branch push、Draft PR作成は対象Actionsの`GITHUB_TOKEN`で行う。checkoutの保存認証は無効にし、validation subprocessへGitHub token・OIDC取得tokenを渡さない。merge、ready、自動mergeの操作は実装していない。

## 記事・locale・検証

正本・route・localeは既存SEO Python catalogに合わせて`src/sites.ts`へ固定した。非記事URL、異なるhost、query、path traversalを許可しない。現段階はMarkdown `.md`だけを改訂対象にし、`.mdx`や正本・localeを一意に確認できない候補は編集しない。

| site      | 正本collection                           | locale     | 更新日時                              | 翻訳hash                                        |
| --------- | ---------------------------------------- | ---------- | ------------------------------------- | ----------------------------------------------- |
| hatt      | `src/content/blog`、公開slug fieldで対応 | ja         | `lastUpdated`                         | 対象外                                          |
| cherry    | `src/content/{blog,news,events,faq}`     | ja         | `updatedAt`                           | 対象外                                          |
| corporate | `src/content/blog`                       | ja + 8言語 | `lastUpdated`                         | 既存schemaへ新しいfieldを追加しない             |
| systems   | `src/content/insights`                   | ja + 8言語 | `lastUpdated`                         | 既存`translation-state.json`のglobal sourceHash |
| portal    | `src/content/stories`                    | ja + 8言語 | `lastUpdated`                         | 各locale frontmatterの`sourceHash`              |
| wiki      | `poc/astro-sveltia/src/content/wiki`     | ja         | unsupported、strict schemaにfieldなし | 対象外                                          |

対応する更新日時fieldが未設定でも、初回改訂で付与する。Wikiはfieldを捏造せず、PRへunsupportedを明記する。公開日・著者・画像・識別子・既存metadataを保護し、コード、外部URL、raw HTMLの追加・改変を拒否する。本文だけでなく翻訳のcopy変更を確認し、hashだけの更新を拒否する。

共通執筆guideは2026-10-19に確認した`seo-content-ops/docs/01-writing-guide.md`の方針を`src/seo-editorial-guide.ts`へ反映した。対象checkoutのAGENTSと、指定するrepository内執筆guideを読み、執筆guideを生成contextに含める。共通・サイトguideに変更があれば、この固定policyと対象pathもレビューする。

生成は既存本文に基づく構成・表現の改善に限定する。外部再調査やリンク先の今回確認は実施しない。新しい参考URL、変わりやすい仕様・料金、実測値、実績、非公開運用の推測を追加しない。Draft PR本文へ「外部再調査未実施、既存本文に基づく構成・表現改善」を明記する。

日本語を改訂・対象repoのformatterで整形してから、既存8言語を1言語ずつ翻訳する。Portalは整形後の日本語全文からhashを決定する。Systemsはpending記事を除外し、全8言語の実改訂後だけ既存hash関数でstateを更新し、他記事・他領域のpending状態を維持する。

通常CMSのサイト別validation（format/content/CMS/Functions/build、Wikiはcheck/test/build）を再利用する。Portal/Systemsではi18n、Corporate/SystemsではSEO検証も行う。Corporateのblog freshnessはlocal commitの実SHAをbase/headへ指定して実行する。全差分は許可記事・locale・必要なSystems stateだけに限定し、validation後にmain SHAとopen PR overlapを再確認する。検証・全locale・差分制約が通るまでpush/PRへ進まない。

## 予算・期限・永続state

全モデル呼び出しは既存`generateSeo`と`SeoBudget`を使い、同一予算run ID・canonical article path・親の絶対deadlineを共有する。初回API呼び出しから30分に設定し直さない。1回1 USD、JST暦月5 USD、1記事、候補3件の範囲を超えない。全9言語が予算へ収まることは保証せず、上限到達時は部分翻訳PRを作らない。

失敗・不明APIの予約は保持する。モデルfallback、生成/翻訳の自動再送、期限延長はない。現在の保守的単価の有効期限は`seo-budget.ts`の`RATE_VALID_UNTIL`（2026-11-19 UTC）で、期限後は再確認まで生成を止める。

`0005_seo_editorial.sql`が外部run・内部予算ID・候補順・job・GitHub run・claim・段階・callback結果をD1へ保存する。source snapshotと段階別受入結果は既存の非公開R2に保存し、public read endpointを設けない。期限到達はstatus照会でも永続`unresolved`へ移し、中央記事lockの保持を依頼する。unknownを理由にrun・予約・branchを削除しない。

## 生成後の構文検査と管理照合

2026-10-19のPortal canaryは、日本語提案の`description:`行に余分な半角スペースが1文字入り、直前の`title`と合わせてYAML mappingとして解析できず停止した。生成そのものは完了し、未受入の原提案はR2に保存されている。再生成せずその1文字だけを除くと既存の内容検査を通過した。

修復は元のYAMLが不正な場合だけ行う。既存の文字列fieldがそれぞれ独立した1行scalarとして解析でき、編集可能なfieldの前に余分な半角スペースが1文字あり、その前後がトップレベルfieldである場合（最後のfieldも可）に限定する。複数箇所、複数スペース、block scalarや複雑な構造の推測修復はしない。修復後も重複key、immutable metadata、URL・コード・数値・HTMLなど全検査を行う。正常なYAML、本文、保存済み原提案を書き換えない。

OIDC操作中の最初の例外は非公開R2の`seo-editorial/{jobId}/failure.json`へ`operation`、`step`、固定allowlistの`code`だけを保存する。未知の例外は`unexpected_error`に置換し、生の例外・本文・provider応答を保存・返却しない。診断保存失敗時も`unresolved`への遷移とcallbackを続行する。この診断追加前のrunについて、後から当時の診断を捏造しない。

今回の照合（2026-10-19 11:15 UTC時点）:

- run `editorial-c515d160-89b5-406a-b215-59aeba75a95c`、job `81312cc5-bf8f-4e8a-8bfe-9e66996e62dc`、[Actions run](https://github.com/acecore-systems/aceserver-portal/actions/runs/39240781522)は終了済み。
- D1は`unresolved`、`next_step=0`、claim/callback記録済み。該当予算runの呼出しは1件、`complete`、予約額58,678 micro USD（実請求額とは別）。期限は2026-10-19 11:23:51.845 UTCで変更していない。
- 原本SHA256は`22e7daa49d737d74089286ebf1a965d34c3ce62833a3a18b8ff4476d65a27414`でD1と一致。D1のcall IDから取得した原提案のSHA256は`482d71da1583660ca66616afce6807c89690e07d239304d9d0e20c255e2cbe1e`、1変更のpathは正本と一致。保存source snapshot全体のSHA256は`f9685fc6985fe13e77f4741b3c5713a616f154c4ef8d0e535ab4a79c108f8e14`。
- 固定時刻（当該予算callのcreated_at）で原提案をローカル再検査した結果は受入可能。新しい生成APIは呼ばず、クラウドへ書き戻していない。8言語は未生成であり、全工程の再開・完了を意味しない。
- publishには全9段階の完了が必要で、単調増加する`next_step=0`はpublish到達条件を満たしていない。対応branch `codex/seo-81312cc5-bf8f-4e8a-8bfe-9e66996e62dc`のref検索と同headの全状態PR検索はいずれも0件だった。これはコード上の到達条件と現在のGitHub存在照合であり、過去の全操作イベントを監査したという意味ではない。

管理復旧の提案は、この証拠と最新状態を再照合して「既知の生成検証失敗・GitHub未書込み」と確定し、旧run/job・原提案・予算予約・記事lockを監査保持したまま、別途承認した管理操作で中央のactive blockだけを解除すること。旧runの期限延長、予算の付替え、終端状態の巻戻し、workflow再実行は行わない。新試行の可否は記事lockを含め親側で判定し、解除と生成を一つの操作にしない。この修正は解除・再開機能を追加せず、台帳やクラウド状態も変更しない。

## 導入と未検証範囲

1. 親SEOの`SeoCoordinator`と中央D1 schemaを先に用意し、親のeditorial flagは無効でdeployする。
2. CMSのD1 migrationを親の受入後・CMS PRのmerge前に適用し、`SEO_COORDINATOR` binding、`SeoEditorial`、OIDC routeを導入する。利用者の導入手順に従い、このPRの`SEO_EDITORIAL_ENABLED`は`true`。CMSにはSEOのCron・自動start・HTTP startがなく、親のeditorial flagが無効な間は開始されない。
3. 各サイトのmainへSHA固定の`seo-content.yml`を導入し、CMSの配置を確認してから親のbinding・editorial flagを有効にする。最初は親のmanual editorialを1回だけ起動し、Cronは無効のまま受入確認する。
4. 親の受入後に実dispatch・実生成・Actions検証・Draft属性・実費/予約・callback・ポーリングを確認する。文章/翻訳の品質レビュー、統合、公開はそれぞれ別工程。

ローカルtestはSQLiteでの永続予算・同時start・重複抑止・絶対期限、署名付きOIDC境界、source/locale/hashの受入、filesystemを使うaction runtimeを検証する。ネットワークとGitHub副作用をfixtureへ置換したruntimeテストを、実際のActionsや有料生成の成功として扱わない。実際のtarget CI起動・required checksの充足も本番受入で確認する。
