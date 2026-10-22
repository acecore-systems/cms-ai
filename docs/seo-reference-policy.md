# Microsoft Learn文書の固定view参照契約

trial3の実discovery応答はMicrosoft Learnの文書を選び、検索sourcesと完全一致していた。一方、旧referenceUrlはqueryを全拒否するため、`view`付き文書はresearch取得前に正常拒否された。本文支持不足とは区別する。保存済み旧jobの拒否は変更しない。

## 新jobだけのreference policy 2

CMS0020で不変の`reference_policy`を追加する。旧jobはdefault1、新規jobは2。Discoveryの既存version1〜4とは別のURL形式契約であり、policy1のrequest・結果・旧receipt再照合は維持する。新policyはpreflight・discovery input hash・成果hash・研究成果に束縛し、load時にjobと一致を確認する。

従来のqueryなしHTTPS公開URLに加え、次の原文形式だけを許可する。

- hostは小文字の `learn.microsoft.com` 完全一致、schemeは `https://`。
- pathは `/en-us/minecraft/creator/documents/` 配下の小文字英数字・hyphenからなる文書segment。空segment、dot segment、percent encodingは不可。
- queryは唯一の `?view=minecraft-bedrock-stable`。preview等の他view値、他locale、任意query、重複key、token、fragment、port、認証情報、encoded表記は拒否する。

URLは書換えず、検索原本URL→固定open→provider citation→採用根拠→全翻訳の参照→PR本文まで同じ文字列を維持する。既存queryなし文書へ固定viewを付けただけの場合は新資料と扱わない（除外比較だけで同一文書を認識し、保存/取得URLは変更しない）。自site/既存URL除外、公式一次資料性、全条件支持、数値/コード/metadata保護、AI校閲は従来どおり。

[Microsoft Learnの対象公式文書](https://learn.microsoft.com/en-us/minecraft/creator/documents/bedrockserver/getting-started?view=minecraft-bedrock-stable)を独立に読取り、Bedrock Dedicated Serverの案内であることを確認した。この独立読取はprovider実取得/支持判定成功の代用ではない。新実装で実trial3の同rawはdiscovery受理、旧policyでは同じ不足拒否となる。研究取得以降は無料fixtureのみで、本番E2E成功は未確認。

## 配備順序と互換性

1. CI成功した本PRの固定40桁headを、6repo（hatt/cherry/corporate/systems/portal/wiki）の `.github/workflows/seo-content.yml` の `uses: acecore-systems/cms-ai/seo-runner@...` へ反映し、PR/CI/merge後に全main pinを読戻す。新runnerは旧policyを受け取れるため先行更新できる。
2. CMS0020をコード配備前に適用。既存全table旧全列の不変、全旧jobのreference_policy=1、更新禁止を照合する。旧migrationは編集しない。
3. CMSの本PRを統合しmain CI/Git連携Build/本番versionを確認。新jobのみpolicy2で開始する。既存run再送・有料試行はこの変更に含めない。

旧pin `7e9ec0af11a7c97470129dfdb5897fd1c2af6956` はresearch応答直後のevidenceReferencesでqueryを拒否し、生成へ進めない。PR本文作成でも旧validatorを使うため、Workerだけの配備では不十分。全6pin未更新ならCMS統合を待つ。途中ロールバックでもpolicy2 jobを旧policyへ書換えず、unknownは保持する。

SEOのreceipt schema・API数・予算上限・期限は変更なし。SEO migration/code変更は不要。新URL形式を通すことは主張支持や生成/校閲/Draft成功を意味しない。
