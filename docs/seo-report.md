# SEO運用結果の読取RPC

既存 `SeoEditorial` Service Bindingの `report({runId})` はD1だけを読み、次の固定9項目を返す。公開HTTP routeはなく、既存 `status` の契約を変更しない。呼出元は自分のrunIdだけを扱う。bindingは既存editorial capabilityであり、run別の所有者認可を新設するものではない。

- `status`: pending / draft_pr / no_eligible_article / unresolved / research_rejected / review_rejected / not_found。
- `phase`: 保存済みchecksの最新到達段階（plan / discovery / research / review）、未実施はnull。生成中でも直前のresearchを示し、現在の生成stepではない。
- `reason`: immutable receiptに基づくconfirmed_insufficient / confirmed_review_rejection、通常のunresolvedはunknown、それ以外はnull。
- `reservedMicros`: 当該budget runの予約額合計。complete・reserved・unresolvedを全て含む。budget row未作成時はnull。
- `monthReservedMicros`: 当該editorial runの作成JST月の予約額合計。現時点の月台帳を読む。課金確定額ではない。
- `monthLimitMicros`: 同じ月の現在の承認済み上限。過去の実行時点の上限履歴ではない。
- `runLimitMicros`: 保存済みbudget run上限を優先、未予約なら保存済みjob version、run未存在／読取失敗なら現行既定値。
- `articleKey`: 保存済みrunの記事key、未設定はnull。
- `prUrl`: draft_prの保存済みURLのみ、それ以外はnull。

入力はrunIdのみ、startと同じstrict runPattern。未存在はnot_foundで全costはnull（runLimitMicrosのみ現行既定）。入力不正やD1失敗はunresolved/unknown、phase・cost・article・URLはnullに閉じる。runLimitMicrosは許容上限であり支出ではない。

単一SELECTでstatus・receiptの存在・checks・ledgerを同じsnapshotから読む。本文、prompt、receipt JSON、raw errorを読み出さず、期限切れjobの更新、callback再送、R2、外部API、予算予約を行わない。月境界をまたぐrunではrun作成月を集計するため、次月callは次月のrunレポート等で確認する。通知は親SEO側の責務。本PRでは通知送信も有料試行も実施しない。
