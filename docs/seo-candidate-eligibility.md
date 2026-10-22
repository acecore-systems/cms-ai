# 記事候補のPR競合事前確認

新規収集の候補順位を最大3件へ切り詰める前に、SEO Workerが `SeoEditorial.eligibility` を呼ぶ。順位式・取得9site・最終runner検証は維持する。既存snapshot/reportの候補は再解釈しない。

## 読取契約

既存 `github.ts` のrepo限定GitHub App installation tokenをメモリ内で再利用する。要求権限は既存の `actions:write` のまま、公開repoのGETのみ。token・認証ヘッダー・本文・PR本文をRPCやR2へ保存しない。匿名fallback、新認証、権限追加はない。

[GitHub公開PR読取](https://docs.github.com/en/rest/pulls/pulls)と[公開blob読取](https://docs.github.com/en/rest/git/blobs)は追加read権限なしで利用可能という公式仕様に基づく。実installationでの成功は配備前後の別受入とし、ローカルmock成功とは区別する。

1site最大100 GETとtoken発行1件、編集可能6site合計最大606 HTTP requests（新規収集1回）。site内は逐次、runnerもsite順に収集する。毎GETのrate-limit limitが5000未満、remainingが606未満、ヘッダー欠落、403/429、期限超過はunknownとする。残量検査は他taskの同時消費を予約する仕組みではない。二次制限も自動再送しない。[installationの最低5000件/時と匿名IPの60件/時](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)を混同しない。

main SHAと完全なrecursive treeを固定し、正本・全locale・共有translation-stateの実在を確認する。全open PRのHEAD/base/updateとchanged_files、全file page、rename元pathを照合し、最後にPR集合とmainを再取得する。tree truncation、PR上限3000files、1000open PR、欠落・変更・API上限はunknown。完全取得を推測しない。

slugからpathが一意なsiteはtreeのpath交差を先に確認し、競合時は本文blobを取得しない。HattはslugFieldを正本から照合する必要があるため本文読取を省略しない。非競合記事は既存sourceIdentityで正本metadataと全locale pathを検証、共有stateのpendingも確認する。blobはGit SHA1で実bytesを照合する。翻訳本文自体の検証はrunnerの最終検査が担当する。

RPCはbase/tree SHA、確認日時、PR HEADとfile集合、記事path/blob SHA、eligible/conflict/ineligibleを返す。conflictは本文未読なのでsource SHA256を返さない。ineligibleは実treeでの原本欠落など、unknownは取得証明不能として区別する。

## 配備・未確認

CMSの新RPCを先に配置し、その後SEOの新規収集を配置する。D1 migration、site runner変更、6site pin更新は不要。App権限を拡大せず、実installationによる公開main/tree/PR/file/blob取得とrate-limit情報を受入で確認する。失敗時は編集を停止し集計をpartialで保持する。PR作成後の新競合raceは既存runner直前検査で拒否する。
