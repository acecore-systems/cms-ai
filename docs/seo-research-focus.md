# 固定targetと周辺文脈の調査契約

通常文plan2で、固定targetの製品機能を説明する資料を取得していても、同じ段落の独立したローカル配置説明まで外部資料による証明対象に含めて `insufficient` になる例を確認した。保存されたAI判定は変更せず、新jobのpromptだけをfocus2へ切り替える。

## 検証境界

- target.quote全文とrequiredConditions全件を固定したまま検証する。短縮・言い換え・条件削除で通さない。
- claimMarkdown全文を保持して読む。独立した配置説明・由来・運用説明は保持文脈であり、外部製品資料の証明義務や確認済み事実へ転換しない。
- targetを限定する版、日時、否定、例外、依存、適用条件は周辺文でも支持が必要。不明は引き続きinsufficient。
- 一次資料の権威、実取得、完全一致URL、全条件、引用、取得順序、最大2open、fallback条件、既存の決定的検査を維持する。

prompt配線と拒否条件を試験した結果であり、モデルの改善効果や実生成・校閲・Draft PR成功を示すものではない。旧応答のinsufficientは最終状態として保持する。再試行は別job・別AI実行となる。

## 0041と旧job互換

`seo_research_focus_contracts(job_id PRIMARY KEY, version=2)` を新job挿入前の同一D1 batchで記録する。未記録はfocus1。既存jobへの後付け、UPDATE、DELETE、REPLACE、job識別子変更をtriggerで拒否する。旧テーブルの行と既存schema定義は変更しない。migration適用前に新Workerを配備しない。

新jobのresearch check入力hashにもresearchFocus=2を含める。旧jobはこのfieldを加えず、従来のpromptとhashを維持する。plan・生成・校閲・runner契約、期限、call数、予算、品質検査は変更しない。research予約は既存8,000 bytes上限による最大値を維持し、実requestにも既存assertStageInputを適用する。保存資料replayは旧5,199→新6,171 bytesで上限内、source・target・requiredConditions・周辺文脈を含むinputは同一だった。

## 読み取り専用reconsiderationProof

旧plan1→2のproof1を維持する。別経路のproof2は次の限定条件をすべて満たす場合だけ返す。

- 旧plan2/focus1、research/retrieval/recovery/reference契約2、confirmed_insufficient、正常な通知記録済み、生成・公開なし。
- 保存planは通常文version2で、targetが段落中の完全な1文。段落とtargetは異なり、requiredConditionsはtarget全文1件。保存source hash、plan再解析、discovery再解析とhashを照合する。
- jobの全check・model call・budget runの全課金行が同一のplan/discovery/research 3件で、全課金complete、末尾researchだけinsufficient。unknown、追加call、異なるrequest hashを拒否する。
- receiptのrun/job/article/source/deadline/base/workflow識別と、R2 receipt原文・hashを照合。全normalized response/manifest hashと保存failureを既存拒否検査で再検証し、判定はinsufficientのまま扱う。proposal・生成・reviewの痕跡があれば拒否する。
- 現在のGitHub workflow完了・固定base一致を確認し、記事branch prefixのrefsが空、全状態PRが空であることをread-only権限で確認する。欠落・不明・paginationは拒否。
- newRunId指定時は旧runと異なるpending runのclaiming jobで、未claim、plan2/focus2、source hash一致、生成・公開なしが必須。
- 呼出側deadlineを受け取り、証跡確認時間を含めた期限超過を拒否する。本番の共有10秒枠に収まるかは親のread-only preflightで確認する。

proofの出力は以下のexact 8 keys（newRunId指定時だけ9 keys）。SEO側の一記事一回、既使用記事除外、lock不変条件は親側契約に従う。

```json
{
  "status": "eligible",
  "version": 2,
  "runId": "old-run",
  "articleKey": "site:path",
  "sourceSha256": "sha256",
  "receiptSha256": "sha256",
  "fromResearchFocus": 1,
  "toResearchFocus": 2
}
```

legacy1はversion=1/fromPlan=1/toPlan=2で、その他の共通fieldと任意newRunIdは同じ。拒否時は `{ "status": "denied" }` のみ。証跡・job・予約の更新やAI呼出しは行わない。

## 検証と引継ぎ

合成fixtureで全proof SQL/R2整合を検証し、workerd D1でもSQL実行・migration batch・FK rollbackを検証する。実Service Binding再入時のclaiming順序を維持する。テストのesbuildはworkerd条件で依存を解決する。

私的原稿・provider応答・ログはGitへ追加しない。任意の保存資料replayは `SEO_FOCUS_REPLAY` にsource/plan/discovery/research-responseのJSONを含むローカルdirectoryを設定し、`npx vitest run tests/seo-research-focus-replay.test.ts` で行う。最終回答の結論と根拠文だけを照合し、raw reasoningを読まない。ログはhash・byte数・判定のみ。通常CIではこの私的fixture試験をskipする。

本番migration適用・merge・deploy・台帳確認・新AI試行は親担当。ローカル/CI成功と実AI成功を区別する。

## 候補0件の読み取り専用診断

配備後の無課金collectionで対象lockが残ったため、実snapshotと保存R2を使って再検証した。focus検証とproof全体はローカルでeligibleとなった。追加取得したGitHub workflow成功・固定head一致・refs空・全状態PR空のレスポンスでも、GitHub関数を含む全体が通過した。認証はローカル合成鍵/HTTP fixtureなので、本番資格情報・rate制限・遅延が通過した証拠ではない。実AIは起動していない。

判定を変えず、`seo_reconsideration_result` の構造化ログを追加する。fieldはoutcome、stage、code、elapsedMs、remainingMs、stagesMsだけ。run/job/article、原稿、receipt、URL、token、例外message/stackは含めない。codeは固定のpredicate/deadline/exception/completeまたは既存GitHub readerの許可済みコードのみ。

stageはinput、old-row、receipt、receipt-object、focus-evidence、new-job、workflow、publication。共有deadline消費、GitHub認証・scope・rate問題と通常の条件不一致を区別するために用いる。返却proofのshape、全拒否条件、10秒共有枠、取得回数・順序は変えない。ログに出た経過時間と本番read-only preflightで原因を確認してから、必要な改善を判断する。
