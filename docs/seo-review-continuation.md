# 生成済み原稿の校閲継続

校閲の provider raw が `finish_reason=length`、最終本文が空、出力24000tokenの場合だけ、新run/jobで保存原稿を校閲する。通信timeoutや品質拒否を成功に読み替えない。旧run/job、旧check、旧予約、旧期限、旧rawは変更しない。

## 接続契約

Service Binding `SeoEditorial` の専用RPCを使う。通常候補選定・通常 `start` に混在させない。

```ts
reviewContinuationProof({ oldRunId, newRunId, deadline });
// eligible: exact 11 keys
// {status:"eligible",version:1,oldRunId,newRunId,oldJobId,articleKey,
// sourceSha256,manifestSha256,filesSha256,checkedAt,deadline}
// denied: {status:"denied"}

startReviewContinuation({ oldRunId, runId, deadline, manifestSha256 });
// {status:"started",jobId} / {status:"stopped"} / {status:"unresolved"}
// 既存同一入力の再送はdispatchを繰り返さない。
```

proofは読み取りのみ。旧期限経過後、新期限は現在から30分以内。既存日本語scope2・生成1ファイル・公開0・plan/discovery/research/generationの4call completeとreview1call unresolvedに限定する。各D1モデル/予算/checkとR2 manifest/応答hashを照合し、保存plan/discovery/researchを元のparserで再評価する。保存研究の確認時刻から24時間以内に新期限を置く。これは新たな資料取得ではない。

旧Actionsは元repository/workflow/main/baseでcompleted/failure、旧記事branch/全状態PRは不存在を再確認する。GitHub失敗・不明・証拠欠落は拒否。既存のsuccess専用呼出しは既定値を維持する。

manifestは旧run/job/check/model/budget行とR2 byte hashを含み、本文・provider raw自体は含めない。manifest原文は新job配下の非公開R2だけに保存する。D1には参照key/hashと一回限定の関連を記録する。proofのcheckedAtと新期限はmanifest hash外で別検査する。

SEO側は旧状態の監査保存、旧期限後の受付復旧、新runへの一回限定owner移管を別途実装する。通常の `claim({runId,articleKey,sourceSha256})` と `complete` は維持。旧runを成功にしない。新run成功は新jobの校閲passと自動Draft PRによる。

## runnerと校閲

サイトworkflowのinputsは既存 `run_id` / `job_id`。CMSが既存workflowをdispatchする。新pinのrunnerは `policy.reviewContinuation:1` を認識し、claimに同値を送る。旧runnerは本文取得・AIより前に拒否する。claim時は現在のmainとOIDC workflow SHAを新baseに固定し、原稿・収集guide全件を旧source bundleと比較する。runner pin更新だけで変わる旧baseとの一致は要求しない。

runnerは保存formatted原稿を取得してhashを検証し、通常のformat・immutable/content・翻訳待ちmanifest・site validationを実行する。整形やvalidationで原稿bytesが変わっても再校閲へ進めない。research/proposeは呼ばず、新review receiptのfiles hashを既存publish gateに渡して自動Draft PRを作成する。新jobのgeneration_startedは0、next_step=1は継承済み成果物であり、新生成成功の捏造ではない。

0043以後の新jobは独立 `seo_review_effort_contracts(version=2)` を登録する。校閲だけ同じDeepSeekモデルのlow、24000token、provider480秒（runner510秒、いずれも新run原期限でmin）とする。既存jobはhigh、plan/generationはhighのまま。length/unknown/schema/品質拒否の検査は緩和しない。lowでも最終回答生成は保証できない。

proof/startで実payloadの上限を見積もり、月残・10月26日留保・1run上限に収まらなければ停止する。実callでも既存D1予約triggerを使用し競合を拒否する。旧予約は返金しない。継続jobはSQLでもreview1callだけに限定し、二重継続・再生成・期限延長を拒否する。

新校閲が品質拒否または不明となった場合もDraftは作らない。既存生成callを持たない継続jobでは通常の品質拒否receiptを偽装せず、unresolvedとして保存・通知する。追加継続は自動許可しない。

## 無課金検証と配備

0043の旧行/schema保持、SQLite/workerd D1 batch・immutability、low/high分離、runnerの固定hash→review→publishを回帰検証する。私的実fixtureは `SEO_CONTINUATION_REPLAY`（trial保存directory）と `SEO_CONTINUATION_EXTRA`（追加R2証跡directory）を指定して `tests/seo-review-continuation-replay.test.ts` で再現する。既存実証跡と模擬AI応答を使うローカル検証であり、実校閲passを意味しない。

配備順は親担当でmigration0043→CMS merge/build→site runner pin更新→無課金proof/受付監査→専用continuation Workflow。実AI、DB/R2本番write、merge、配備、旧lock移管は実装担当から実行しない。実生成→新実校閲pass→自動Draftの受入は本番確認後に別途記録する。

## claim の JSON キー順による誤拒否の修正

保存 source は `{content,path}`、runner の読取結果は `{path,content}` となるため、JSON 文字列全体の比較は同一原稿でも claim を拒否していた。path ごとの厳密な content 一致へ変更し、全ファイルの件数・一意性・正確なキー集合も検査する。本文や guide の正規化・省略は行わず、保存 source と manifest の bytes/hash は維持する。

固定診断コードのみを failure に残し、本文・例外メッセージは記録しない。既存の期限、予算、校閲、公開 gate は変更しない。自動再開 API や migration は追加していない。

無課金の実資料 replay は `SEO_CONTINUATION_REPLAY` / `SEO_CONTINUATION_EXTRA` にローカル証拠、`SEO_CONTINUATION_SITE` に実サイト checkout を指定する。実 runner の collect → JSON HTTP claim →既存校閲・Draft gate を検証する。AI と GitHub/OIDC はテスト代替であり、実校閲成功や実 Draft 作成を示さない。私的 fixture はコミットしない。通常回帰は改変・欠落・重複・余分 field を拒否する。
