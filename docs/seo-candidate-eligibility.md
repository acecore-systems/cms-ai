# 記事候補のPR競合事前確認

新規収集の候補順位を最大3件へ切り詰める前に、SEO Workerが `SeoEditorial.eligibility` を呼ぶ。順位式・取得9site・最終runner検証は維持する。既存snapshot/reportの候補は再解釈しない。

## 読取契約

既存GitHub Appのtoken発行経路を用途で分ける。dispatchは従来どおり対象repo限定 `actions:write`。eligibilityは同repo限定 `contents:read` と `pull_requests:read` だけを要求し、返却された権限もread-onlyと照合する。tokenはメモリ内のみで、認証ヘッダー・本文・PR本文をRPCやR2へ保存しない。匿名fallbackや自動権限追加はない。

2026-10-23の実App grant読取ではactions/metadataのみだった。初回本番read-onlyはcandidate_selection_unavailableで安全停止したがHTTP状態が未保存のため403とは断定していない。公開リソース一般の仕様だけでinstallation tokenの読取権限を十分とみなさず、App登録とinstallation両方でread権限の承認後に実確認する。

失敗は従来RPC `seo_eligibility_unknown` のまま。CMS structured logの `seo_eligibility_unavailable` eventに固定codeだけを記録する。codeはtoken_authentication/token_permission_denied/token_unavailable/token_scope_mismatch、read_authentication/read_forbidden/read_unavailable、rate_evidence_missing/rate_insufficient、request_bound/unknown。token_permission_deniedはGitHubのtoken発行403/422を示し、未grant以外の発行拒否も含む。応答本文・例外全文・URL・tokenは記録しない。SEOの既存partial終了契約は変えない。

1site最大100 GETとtoken発行1件、編集可能6site合計最大606 HTTP requests（新規収集1回）。site内は逐次、runnerもsite順に収集する。毎GETのrate-limit limitが5000未満、remainingが606未満、ヘッダー欠落、403/429、期限超過はunknownとする。残量検査は他taskの同時消費を予約する仕組みではない。二次制限も自動再送しない。[installationの最低5000件/時と匿名IPの60件/時](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)を混同しない。

main SHAと完全なrecursive treeを固定し、正本・全locale・共有translation-stateの実在を確認する。全open PRのHEAD/base/updateとchanged_files、全file page、rename元pathを照合し、最後にPR集合とmainを再取得する。tree truncation、PR上限3000files、1000open PR、欠落・変更・API上限はunknown。完全取得を推測しない。

slugからpathが一意なsiteはtreeのpath交差を先に確認し、競合時は本文blobを取得しない。HattはslugFieldを正本から照合する必要があるため本文読取を省略しない。非競合記事は既存sourceIdentityで正本metadataと全locale pathを検証、共有stateのpendingも確認する。blobはGit SHA1で実bytesを照合する。翻訳本文自体の検証はrunnerの最終検査が担当する。

RPCはbase/tree SHA、確認日時、PR HEADとfile集合、記事path/blob SHA、eligible/conflict/ineligibleを返す。conflictは本文未読なのでsource SHA256を返さない。ineligibleは実treeでの原本欠落など、unknownは取得証明不能として区別する。

## 配備・未確認

CMSの新RPCを先に配置し、その後SEOの新規収集を配置する。D1 migration、site runner変更、6site pin更新は不要。承認されたread権限を同じ選択repo群へ適用後、実installationによる公開main/tree/PR/file/blob取得とrate-limit情報を受入で確認する。失敗時は編集を停止し集計をpartialで保持する。PR作成後の新競合raceは既存runner直前検査で拒否する。

## App権限の承認手順（コード配備とは別）

所有者は `acecore-systems`、Appは `acecore-cms-ai-runner`、installation IDは157933151。認証済みRESTで所有者と現在grantを確認した。設定UIの操作・変更はこのPRで行わない。

1. OrganizationのDeveloper settings → GitHub Apps → 対象App → Permissions & eventsでContentsとPull requestsをRead-onlyへ追加する。ActionsはRead and writeを維持し、他権限・対象repoは変更しない。
2. installation側で更新権限を確認・承認する。登録側保存だけでは既存installationへ有効にならない。
3. App登録・installationの両permissionsと対象repo集合不変をread-only照合する。
4. 本修正CMS配備後、SEO新候補選別を配置して新IDのmanual_read_onlyを一度確認する。失敗時は固定codeを照合し、記事生成や匿名fallbackで回避しない。

入口は [App登録設定](https://github.com/organizations/acecore-systems/settings/apps/acecore-cms-ai-runner/permissions) と [installation設定](https://github.com/organizations/acecore-systems/settings/installations/157933151)。これらは所有者/IDとGitHubの経路から示す管理入口であり、現在ログインでのUI到達は未確認。[公式の変更手順](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration)と[更新権限の承認](https://docs.github.com/en/apps/using-github-apps/approving-updated-permissions-for-a-github-app)に従う。秘密鍵再取得・token転記・新App作成は不要。

## 外部調査の編集対象外

`SEO_RESEARCH_EXCLUSIONS` は実原稿を読んで確認した編集対象外の正本pathをサイト別に明示する。Wikiの `rinen.md` は運営自身の理念・目標の宣言だけであり、第三者資料による裏付け対象ではないため除外する。技術記事や外部リンクのない記事を一律に除外しない。新規候補照合の `owned_policy_not_external_research` として記録し、過去snapshot・記事・ロックは変更しない。将来このページに外部検証対象の事実を追加する場合は、この一覧を再レビューする。

## 無料候補品質チェック（2026-10-23）

新規収集のeligibilityだけで、既存plannerのselectable文をさらに確認する。製品名に見える主語だけで、自身の創作活動・制作実績・採用や実装の経験を外部製品仕様と扱わない。製品未特定の「AIがコードを読み込み／ブラウザを操作する」という個別作業説明も除外する。候補が残らない記事は既存の `no_external_factual_claim` を返し、翻訳・guide本文の追加取得、記事lock、API予約、モデル呼出しに進まない。

タイトル・site単位のブロックではない。制作事例の別段落に独立した原文の技術仕様があれば対象を維持する。表は既存の厳密な製品／機能2列・exact行・前後の歴史的注記の契約をそのまま使う。原稿、条件、否定、コード、URL支持条件を変えず、事実を新しく合成しない。語句による保守的なheuristicのため取りこぼしはあり、候補ありも外部資料での支持やplanner成功を保証しない。

保存済みsnapshotからのstart、既存jobのclaim、planner入力／parsePlan／receiptは再解釈しない。新規収集を経由しない直接startへの適用は範囲外。plannerを同じ判定へ変更する場合は、新jobのversionを導入して旧jobと分ける必要がある。

ローカル非公開原稿の再生（本文はcommitしない）：trial7と15は旧候補あり→新候補なし、trial10と14は候補ありを維持。`CMS_CANDIDATE_REPLAY_DIR` にtrialディレクトリの親を設定すると `tests/seo-candidate-quality.test.ts` の任意再生を実施できる。未設定のCIではこの1件だけskipする。これは無料の候補判定の再生であり、課金planner／生成／校閲／Draft成功の実証ではない。

### insufficient後のfallbackの境界

現在の `seo_research_rejections` はrun単位でUNIQUE、receipt確定でjob/runを終端化し、job・budget run・article key・期限・checks・予算callの変更をtriggerで禁止する。`advance` が次候補へ進むのはclaim前のineligibleだけ。終端receipt後に同じrunを再開する変更は安全な小修正ではない。

将来の実装案は親coordinatorで最大候補数を固定したattempt IDを新設し、各attemptのCMS run/job/receiptを独立に保持すること。記事lockの確定解放、重複通知の冪等性、親全体の累積予算上限・期限・月残を維持し、不明な失敗では進まない条件をCMS/SEO双方で合意・version化する必要がある。今回この契約・予算・migrationは変更しない。

## 確定不足記事の一度だけの再検討

SEO coordinatorの`article_reconsiderations`と組み合わせる読み取り専用Service RPC `reconsideration`を追加した。公開HTTP入力や旧run再送ではない。旧CMS job/runが確定不足の終端で、生成・公開・進行callがなくcallback済み、D1 receiptと不変R2 receiptが完全一致し、生成stepが存在しない場合だけproofを返す。保存済み計画契約がv1、現行の新jobがv2でsource SHAが同一という限定条件である。v2で不足になった記事やsource変更を理由とした再試行は許可しない。

callbackはworkflow終了前に届くため、それだけで終了済みとは扱わない。保存済みGitHub run IDについて、repo限定`actions:read` tokenで1回GETし、repo・workflow path・main・base SHA・workflow_dispatch・completed/successの一致を確認する。通信失敗、権限不明、実行中、失敗終了は拒否する。認証の追加、権限拡張、dispatch、モデル呼出しは行わない。

新jobはsource検証・予算preflightを通り、claiming状態をD1へ保存してからSEO claimを呼ぶ。SEOは旧lock ownerを読み、このCMS RPCへ新run IDを渡して再入する。新jobがclaiming/claim未記録、期限内、plan v2、同一sourceであることを照合する。待機中に旧処理を再開せず、DB transactionをService RPC越しに保持しない。SEO側の監査付きowner移行成功後、CMSがclaimedへ進む。途中障害は保守的に停止し、旧runを操作しない。

CMS migrationは不要。配備側はSEO migration0023とCMSのRPC追加を先に用意し、SEO側の新収集・claimを有効にする。CMSだけ先行しても既存SEOは呼ばず、SEOだけ先行した場合のRPC欠落はlockを保持する。旧receipt/model/input/予算/期限は変更しない。ローカル合成fixtureは新claim→同期proof→claim確定の順序を確認するが、本番の新規AI・検索・生成・校閲・Draft成功は別の実確認が必要である。
