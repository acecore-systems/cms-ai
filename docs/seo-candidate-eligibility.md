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
