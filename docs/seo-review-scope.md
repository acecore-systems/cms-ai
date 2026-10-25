# 差分校閲scope2と生成済み原稿の再評価

保持必須コードを含む既存課題と、改訂で追加・再導入・悪化した問題を区別する。本文のbyte不変だけでは免除しない。変更文脈・新結論の前提となった既存誤り、意味・限定条件の欠落、外部資料の支持不足、判定不能は引き続きfailとする。見出しの統合は作者の内心ではなく実際の意味・階層・参照への影響を判定する。

scope2はsharedを完全展開した両本文からexact引用を要求する。baselineは両本文で同一引用が存在し、変更主張に影響しない場合のみ許可する。baseline課題はpass時もDraft PRの「既存課題（今回未修正）」へ引き継ぐ。PR中の説明はMarkdownとメンションをエスケープする。これは記事全体に既存問題がないという認定ではない。

## 通常job

0045の不変seo_review_scope_contractsを新規日本語job作成と同じtransactionで記録し、今後の通常jobにもscope2を適用する。既存jobへの後付け・削除・書換えは禁止し、未記録の既存jobはscope1を使用する。事前入力サイズ計算もscope2を使用する。通常の失敗は従来の生成1・全5call完了等を全て検証し、既存v4拒否receiptへ記録する。通常job向けSEO受入schema変更はない。

## 生成済み原稿の限定再評価

入口は期限切れのv2 review continuationだけ。旧scope1の完了failをraw provider、normalized応答、payload hash・予約、保存source・生成稿、元生成provenance、GitHub failure/attempt1・ref/PR不存在まで再検証する。旧failをpassへ変更しない。今回の原稿だけを固定して新run/jobのscope2校閲を1call実施する。同一root/articleのscope1→2は1回限り。通常jobの過去拒否からの再評価は未対応。

proofは既存11keyにfromReviewScope=1、toReviewScope=2、rejectionSha256を加えたversion3の14keys。oldJobIdは直前の完了fail job。manifestSha256とfilesSha256は元生成のまま。startはoldRunId/runId/deadline/manifestSha256の4keysを維持する。新job監査は独立scope manifestと0045のseo_review_scope_reassessmentsへ保存する。旧run/job/予約/原期限/失敗/R2は保持する。

新jobは生成0、校閲low/24000token/480秒の1callのみ。新規30分期限以下で証拠再確認を行い、予算不足時はAIなし停止する。旧期限の延長・旧予約の返金・生成やAIの自動再送は行わない。runnerのv3は既存Draft gateを再利用し、claim/publish/review-rejectの証拠確認枠150秒、reviewの全処理枠630秒を元期限以下に制限する。

## 継続jobの拒否receipt

v5は25keys: version/runId/jobId/articleKey/sourceSha256/deadline/calls/files/filesSha256/sourceBundleSha256/reason/researchContract/generationCalls/generationArtifacts/publicationStarted/baseSha/githubRunId/refs/pullRequests/decisionTime/reviewScope/rootRunId/rootJobId/manifestSha256/inheritedGenerationArtifacts。

新v3の拒否はreviewScope2、generationCalls=0、generationArtifacts=0、inheritedGenerationArtifacts=1、当回review1call completed。元生成はrootRunId/rootJobId/manifestSha256で別に証明する。CMSのimmutable seo_scope_review_rejectionsへ保存後、既存rejectReview APIで通知する。旧scope1の拒否証明は同tableのscope1監査として保持するが、旧SEO通知を再送しない。

## 検証と限界

テストでは旧raw failを保存したまま、HTTP claim→実reviewArticle（AI応答だけstub）→pass時publish/finishとfail時v5通知を確認する。通常jobのv4拒否、旧scope1互換、exact引用/未知/追加field/新結論依存拒否、Draft既存課題引継ぎを検証する。私的本番fixtureとログはSEOrootの.local/review-continuation-20261025に置き、記事・raw応答・reasoningはcommitしない。

ローカル/CI成功はモデルの実改善効果や本番Draft PR成功を示さない。実AI、migration適用、merge/deploy、Systems runner pinと本番確認は親担当。

### 今回のローカル結果

Node24で全941成功・5skip（私的fixture4件と既存1件）。実保存trial3/4/5の全D1行とR2原本をローカル結合し、root manifest/生成稿hash不変、proof14keys、新v3 claim、実reviewArticle、publish/finish、旧全行保持を確認した。AI応答とGitHub APIだけ模擬で、新規有料AI呼出しはない。新校閲payloadは58,627 bytes、上限48,846 microUSD。保存済みscope1 failはそのまま残る。

型生成・型検査・Prettier（Windows既存改行を保持するend-of-line auto）・dry-run成功。並列2worker時の既存0041実D1テスト1件は5秒timeoutとなったが、timeout値は変更せず単独41件と単一worker全件の再確認で成功した。ログはscope-all-tests-final.log、scope-final-targeted.log、scope-actual-replay.log、scope-format-check.log、scope-types.log、scope-typecheck.log、scope-dryrun.log。
