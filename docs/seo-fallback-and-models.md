# 新規運用の候補継続とモデル固定

新規受付だけを対象とする候補継続 protocol 1。`FALLBACK_ENABLED=true` で受付時に適格マーカーを保存する。旧runの再送・移行は行わず、既存のreceipt、lock、監査行、triggerを変更しない。月曜09:00 JSTと通知専用Cronは維持する。実配置・有料実確認は本変更の検証に含めない。

## 共有する契約

無料収集の候補集合を保存し、同一記事の言語違いを除外して最大3候補を固定する。各試行は独立した既存runで、親の元30分期限・累積1.25 USD・生成対象1記事を共有する。先行runの全jobが終わり、CMSとSEOの不変receiptのhash、生成未開始、PR/refなしが一致する確定根拠不足だけが次候補へ進める。未知、障害、生成開始、校閲拒否は停止する。保存済み候補に任意の公開payloadを注入する経路は追加しない。

CMS側の共有予算triggerとSEO側の受付fenceを併用し、試行間にも他runが割り込まない。各候補の実際の保存済みgenerationAllocationから全工程の保守上限を求め、親残額と月残額を満たさなければAI呼出し前に正常skipする。利用実績の見積りやキャッシュ割引は使わない。

## モデルと予算

CMSの新規jobは明示設定 `SEO_AI_MODEL=@cf/deepseek-ai/deepseek-v4.1-flash-1017` のときだけprofile 2を保存する。文章判断・生成・校閲はWorkers AI Chat Completions、調査・検索はLuna hosted search。既存jobのprofile未登録はLunaのままで、設定切替後も変わらない。通常CMSモデルは変更しない。

10月11.89 USD、通常月7 USDを維持する。新profileの10月26日00:00 UTC前の予約は月累積10.64 USDまでにSQLで制限し、月曜分1.25 USDを残す。全phaseに監査先行→予約の同一transactionを要求する。監査なし・上限超過は原子的に拒否し、失敗・不明な呼出しも予約額を保持する。候補数のmanualオプションは追加しない。

## 通知と配備順序

通知は親logical runの結果と累積費用を1回記録する。途中の根拠不足で親を見送り通知せず、子試行も個別送信しない。未知の配送結果は再送せず既存の通知契約を維持する。

追加migrationはCMS `0031_seo_fallback.sql` / `0032_seo_text_models.sql` とSEO `0022_fallback.sql`。先に両DBへ追加し、CMS service RPC対応を配置してからSEOの新規受付を有効にする。旧schema/全旧行のsnapshot replayと配置後readbackは別途必要。停止には新規受付のFALLBACK_ENABLEDまたはSEOの明示モデル設定を切り替えるが、進行中jobのpinは変更しない。

## 検証の範囲

回帰テストは根拠不足→次候補成功、全候補不足、多言語dedup、期限、未知receipt、同時受付、再実行、共有上限、通知集約を対象とする。CMSの実D1互換テストで監査なし拒否、超過rollback、競合予約1件だけ成功、10.64 USD到達を確認する。providerはmockで、実モデル品質・実Workflow・生成からDraftまでの本番成功は未確認。

モデル仕様: [Cloudflare DeepSeek](https://developers.cloudflare.com/workers-ai/models/deepseek-v4.1-flash-1017/)、[OpenAI互換API](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)。input 0.30/output 1.20 USD per million tokens、reasoning high、reasoning分を含むmax_completion_tokensで保守計算する。
