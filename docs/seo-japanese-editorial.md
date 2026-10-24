# SEO日本語改訂と翻訳工程の分離

新規SEO jobは日本語正本の改訂・整形・独立AI校閲・Draft PRで終了する。統合後の翻訳は対象repositoryの既存工程へ引き継ぐ。AI校閲は人の母語話者校閲とは区別する。

## 保存契約

- migration0038は独立した `seo_editorial_scope_contracts` を追加する。新jobの作成と同じtransactionでversion2を先に登録し、deferred foreign keyで孤立rowを拒否する。
- side-tableのない既存jobはscope1で、翻訳を含む従来のpath・生成・校閲・receiptを維持する。既存jobへの後付け、scopeの更新・削除・置換を拒否する。旧table・trigger・viewの定義と既存rowを変更しない。
- runner policyの `editorialScope` とclaimの値を一致させる。scope2は日本語1ファイルと必要なdocsだけをCMSへ渡す。翻訳本文・翻訳state・pending manifestをAI入力へ混ぜない。
- eligibility、生成allocation、保存済みpreflight、生成instruction、最終校閲に同じscopeを適用する。旧preflightにscopeがなければ1と解釈する。
- scope2は日本語生成1call。計画・探索・根拠確認・最終校閲と合わせ、通常の完了経路は5calls。予算・期限・根拠・metadata・コード保持の検査は維持する。生成input poolは1ファイル分の58,333 bytes。

## 整形・拒否・Draft

step0後に対象siteの整形を実行し、最終校閲で保存済みstep0と最終ファイルのmetadata・GFM AST一致を検証する。step1の仮設や整形だけの追加AI callは行わない。AI校閲・publishのhashは最終バイトへ結び付く。

校閲拒否はversion4、1file、5calls、既存receiptと同じkey集合で `seo_japanese_review_rejections` に保存する。scopefieldをreceiptへ追加しない。version3の旧table/triggerは緩めず、新tableのstate・予算・check・job/runのterminal guardを独立させる。callback紛失時の再通知は同じreceiptを再利用する。

runnerは全siteでDraftだけを作る。新scopeではtranslation-state更新処理を呼ばない。Portal/Systemsはsite設定で指定した次の処理を整形後・validation前に実行する。

```text
node scripts/stage-seo-translation.mjs --source <Japanese path> --base-sha <HEAD>
```

出力 `src/i18n/pending-seo-revisions.json` はsite formatterで整形し、日本語正本とともに明示的にstagingする。新規manifest以外のuntracked fileや許可外差分は拒否する。marker検証はsite側のvalidationが所有する。script未配備・validation失敗ならDraftは作らない。

既存markerの対象記事で1つでも元翻訳hashが残る場合、eligibility/collectは有料処理前にskipする。全訳更新後の履歴markerは次回site stagingで整理される。旧訳を最新と偽るsourceHashやstate更新は行わない。

## site接続確認

2026-10-24の読み取り確認では、Corporateはmain更新後15分で8言語Batchへ接続済み。SystemsもBatch接続済みだが旧stateとの鮮度検証があり、pending baseline対応が必要。Portalはmain pushのpathがStories対応でも、CMS commit限定判定で通常SEO PRをskipするため、SEO統合検出とpending検証の追加が必要。Wiki・Cherry・HattはSEO設定上日本語のみ。

Portal/Systemsのsite script・validator・翻訳起動条件、SEO coordinatorのreceipt4受信は親タスクで実装する。site側変更を伴わずCMSだけで本番成功とは扱わない。

## 検証と配備境界

無課金fixtureでrunner→実CMS handler→日本語生成→最終校閲→Draft、校閲拒否、整形改ざん、scope不一致、過去job保護、allocation証跡、callback再通知を検証する。provider・GitHub writeはmockであり、実AI品質・実workflow・本番成功の証明ではない。migrationはSQLiteで旧schema/row不変を確認し、ローカルD1でも新job同時登録と孤立row rollbackを検証する。

本番migration、統合、workflow dispatch、有料試行はこの実装作業では行わない。親がsite変更・coordinator・CMS・runner pinの配備順を確認して実施する。
