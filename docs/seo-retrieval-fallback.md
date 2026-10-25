# 取得不能時の一次資料fallback契約

新jobだけでretrievalFallback=2を記録する。検索実結果に、固定target全文と全requiredConditionsにそれぞれ独立して関連する一次資料が2件あるときは、具体的な機能説明ページを優先し、もう1件を取得不能時のfallbackとして確保する。適格な1件しかなければnullを許す。検索snippetは関連性の手がかりであり、支持の証明ではない。

URLは実検索結果のexact URLだけを使う。canonical、言語、版、path、fragment、mirrorを推測して書き換えない。旧版・preview・無関係・部分的支持の候補で枠を埋めない。既存URL/source-site除外、一次資料の所有/リンク根拠、全条件一致を維持する。検索は1回、取得は最大2openのまま。最初の本文が取得できたが不十分/矛盾だった場合は停止し、fallbackへ進まない。

## 0042と互換性

`seo_retrieval_fallback_contracts(job_id PRIMARY KEY, version=2)` を新job作成前の同一D1 batchで記録する。未記録は旧1。既存jobへの後付け・更新・削除・置換とjob識別子変更を拒否する。旧テーブル行と既存schema定義は変更しない。新Workerの前に0042を適用する。

discovery check入力hashに新jobだけretrievalFallback=2を含める。旧jobのprompt/hash、保存discovery/responseの検証は従来どおり。JSON応答schema、品質検査、予算、deadline、runner、AI call上限は変更しない。実保存資料のdiscovery requestは5,533→6,526 bytesで既存8,000 bytes以内。source/target/全条件を含むinputは同一で、全工程予約の最大値も変更しない。

## proof3: 新jobへの限定的なavailability retry

proof1/2を維持し、次の追加条件を満たす場合だけproof3を返す。

- 旧plan2/focus2/retrievalFallback1、research/retrieval/recovery/reference契約2、confirmed_insufficient。
- 既存proof2と同じ、旧source/完全な固定target/全条件、3call全完了、予約・model call・check対応、全R2 hashとreceipt照合、生成・公開なし、GitHub workflow完了・固定head・現在のrefs/全状態PRなしを要求する。
- 保存discoveryはversion5、selectedUrlあり、fallbackUrlが厳密にnull。
- 保存research応答はinsufficient、sourcesが空。実web_search_callはcompletedのopen_page1件のみで、URLは保存discoveryのselectedUrlと完全一致。retrievalも同URL1件でunavailableを宣言していること。追加call、不明、retrieved、sources追加、fallbackありを拒否する。
- newRunId指定時、新pending runのclaiming jobはplan2/focus2/retrievalFallback2、未claim・同source hash・生成公開なしでなければ拒否する。

providerがunavailableと宣言したことと、実openの記録を照合する契約であり、HTTP原因や将来の取得成功を保証しない。旧insufficientをverifiedへ変更せず、新jobの試行適格性だけを返す。記事ごとの利用回数・現ownerからの移管・既存再選定記録不変はSEO側の独立したarticle_availability_retries監査契約で管理する。CMSはlockを変更しない。

```json
{
  "status": "eligible",
  "version": 3,
  "runId": "old-run",
  "articleKey": "site:path",
  "sourceSha256": "sha256",
  "receiptSha256": "sha256",
  "fromRetrievalFallback": 1,
  "toRetrievalFallback": 2
}
```

exact8 keys、newRunId指定時だけ9 keys。拒否は従来のdeniedのみ。診断stageはavailability-evidence。R2 cache・最大4並列は同じproof内だけで使い、共有期限を延長しない。

## 検証範囲

実trial2のsnapshotと保存R2、実取得したGitHubレスポンスを用いたローカルreplayはproof3 eligible。実資格情報・通信時間・新AI成功を確認した結果ではない。保存応答はinsufficientのまま。合成fixtureでは全hashを再封印したretrieved/sources追加/open変更や、正しく解析可能なfallbackありdiscoveryも拒否する。新flag欠落、unknown call、生成公開開始、source変更を拒否し、D1でもproof2/3とmigrationを検証する。

私的fixtureはcommitしない。`SEO_FALLBACK_REPLAY` にtrial directoryを指定し `npx vitest run tests/seo-retrieval-fallback-replay.test.ts` で実入力サイズと旧拒否維持を確認できる。通常CIはこの試験をskipする。ログはhash・byte数・固定状態のみ。

本番migration、merge/deploy、SEO監査・回数制限、無課金preflightと新AI試行は親担当。実生成・校閲・Draft PR成功は未確認。
