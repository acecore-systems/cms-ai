# 新規SEO generation 契約 v2

保存済みDeepSeek応答が `finish_reason=length`、completion 12,000 tokenで終了したため、生成だけの新契約を追加する。既存jobは再送・更新せず、未登録をv1として従来の12,000 token・provider120秒・runner150秒を維持する。

## 上限と品質

新しいDeepSeek jobだけ、migration0034の追記専用 `seo_generation_contracts` にv2を登録する。jobより先に登録して同一D1 batchでcommitし、deferred FKで孤立登録を拒否する。既存jobへの後付け、登録の更新・削除・replace、job identity変更を拒否する。

v2はgenerationの `max_completion_tokens=48000`、`reasoning_effort=high`。strict schema、原文保持、許可path、生成後AI校閲、Draft終了は維持する。plan/review/searchと通常CMSの設定は変えない。リクエストhash・model・phaseの監査と、予約後1回だけ呼び出す境界も維持する。

[公式モデル仕様](https://developers.cloudflare.com/workers-ai/models/deepseek-v4.1-flash-1017/) の input 0.30 / output 1.20 USD/Mを使い、キャッシュ割引を使わない。thinkingを別枠として追加せずcompletion全体を課金上限に含める。各localeの保守最大費用は旧契約から43,200 microUSD増える。全工程最大は1 locale 518,363、9 locale 1,138,827 microUSD。既存の1 run 1,250,000、月額上限、10月26日留保は増やさず、保存allocationと実際の新payloadから無料事前判定する。

48,000は最小必要量の実測値ではない。保存JA原稿は6,696文字・12,493 UTF-8 bytes、JSON content文字列だけで12,760 bytes。全文と変更理由等にhigh推論を加える余裕を設けた設計値である。12,000で返った本文が3,703文字だったことは確認できるが、reasoning別token数は確定できない。24,000では不足する／48,000なら必ず成功するとは断定しない。

## 期限とrunner配備

実測約104秒で12,000 tokenだったため、cap増加だけで120秒timeoutへ移ることを避ける。v2 generationだけprovider最大480秒、runner propose最大510秒とし、それぞれ元のrun deadline残時間で短縮する。104秒の4倍約416秒に余裕を加えた値であり、速度保証ではない。30分の全工程deadline・workflow timeoutは変更しない。9 locale全てが480秒使える保証はなく、期限を超えれば安全停止する。自動再試行はしない。

生成はrunnerからCMSへのHTTP proposeで実行され、coordinator Service RPCで生成完了を待つ経路ではない。[Workers duration](https://developers.cloudflare.com/workers/platform/limits/) と [Workers AI limits](https://developers.cloudflare.com/workers-ai/platform/limits/) に硬い120秒制限は見つからなかった。実providerの長時間応答は未確認。

runnerはreadで固定された `policy.generationOutput` を読み、新契約のclaimに `generationOutput:2` を送る。旧runnerが新jobにclaimすると、lock取得・AI開始前に拒否する。配備担当は各サイトの共通action SHAを更新する必要がある。配備順序はmigration0034（SEO側0024も先行）→CMS/SEO対応版配備→全対象siteのrunner SHAを最終CMS merge SHAに更新しCI確認→primary/GitHub/R2 proof再取得→admin受付復旧。site pin反映完了までは既存global blockを維持し、未対応runnerへdispatchさせない。旧jobの期限・payload・予算予約を変更するための移行はない。

## 通知と検証

生成開始後かつreview未開始ならreportのphaseをgenerationとする。保存済み通知の再送・改変はしない。生成打切りのglobal受付復旧はSEO側の独立admin契約0024で扱い、CMS job・call・lockを変更しない。

ローカル回帰、型検証、実D1 batchの孤立登録rollback、全旧行/schemaのmigration replayを実施する。実AI成功は未確認。非公開候補replayは `CMS_CANDIDATE_REPLAY_DIR` 未指定時のみskipされ、通常CIへ原文を持ち込まない。
