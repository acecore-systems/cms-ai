# SEOの新規資料調査とAI校閲

2026年10月20日の利用者指示による追加。通常CMSの会話・生成APIは変更しない。新機能は初期無効で、実API・クラウドE2Eは未確認。テストで用いる検索応答、出典、校閲結果は合成fixtureであり、実資料の取得成功や記事品質の証明ではない。

## 実行と根拠

新規jobの作成時にprotocolを固定する。`SEO_RESEARCH_ENABLED=true`、または完全一致する`SEO_RESEARCH_CANARY_RUN_ID=editorial-UUID`のjobだけv2。既存jobと初期無効時はv1を保持する。Service Bindingのstart/status、OIDC audience・repository・workflow、main/source hash、claimとDraft終了の契約は維持する。

v2は対象Actionsがsource・open PRを確認して中央claimを取得した後、次の順に進む。

1. `research {}`: 共用Secrets StoreのOpenAI認証をWorker内だけで利用し、`gpt-6-luna`のResponses APIで今回のテーマをキーワード検索する。新providerや追加認証は使わない。
2. 最大3回のhosted `web_search` callで検索とページ取得を実施する。検索query、検索で発見したURL、完了した`open_page`、`url_citation`、構造化結果の支持判定が揃うことを確認する。最低1つは正本に未掲載のURLでなければ停止する。単なる既存URL再取得、検索結果要約のみ、資料不足・反証・不明は成功扱いしない。
3. 既存本文の主張へ資料を対応付ける。新しい数値・企業実績・運用情報を生成する機能ではない。新規リンクは証跡にあるURLだけ許可し、metadata・コード・数値等の既存guardを維持する。URL内の数字だけは確認済みURLについて数値guardの対象から除き、本文の追加数値は拒否する。
4. 日本語改訂→整形→既存localeの順次生成を行う。全APIは同一budget run・同一絶対deadlineを使う。対象repoの既存検証後、`review {files}`で最終9ファイル（単言語siteは1ファイル）をAI校閲する。
5. 校閲前に全fileを保存済み成果とMarkdown AST・metadataで比較する。日本語に追加した新規参考リンクが各localeでも存在することを検査する。AIは事実・条件・否定・意味、言語の自然さ、未翻訳断片、リンクの主張支持を確認する。全pathがpassの場合だけ`publish {filesSha256}`を許可し、校閲した最終bytesから変わっていればrunnerも停止する。

資料・検索結果・ファイル内の指示は信頼しないデータとして扱う。新規参考URLはquery・fragment・認証情報を含まないHTTPSに限定し、WorkerやrunnerはそのURLへ直接fetchしない。資料取得はhosted toolが行う。PRには実施日時とクリック可能な出典URLを記載し、AI校閲を人の母語話者校閲と称さない。

公式一次資料の選択・主張支持・抜粋抽出はAI判断を含む。`open_page`の完了は取得操作の証跡であり、モデルの抜粋が取得原文とbyte単位で一致する保証ではない。資料全文の独立保存、ドメイン所有者による公式性の検証、人の母語話者確認はこの実装に含めない。校閲失敗時の自動修正・自動再生成も行わず、具体的issuesを運用担当者へ引き継ぐ。

## 予算・期限・保存

既存`SeoBudget`とD1 triggerの1 USD/run・5 USD/JST月を共用する。台帳のarticle keyは既存生成と同じCMS site ID＋正本path、中央lock keyは従来どおりSEO site key＋正本pathであり、混同しない。期限はcoordinatorから渡された絶対時刻。検索・校閲のAPI timeoutは残時間と120秒の小さい方、再試行・fallback・別runへの付替え・予約返却はない。

[公式料金](https://developers.openai.com/api/docs/pricing)と[モデル仕様](https://developers.openai.com/api/docs/models/gpt-6-luna)、[検索仕様](https://developers.openai.com/api/docs/guides/tools-web-search)を2026-10-20に確認した。Standard固定、入力はlong context cache write 0.25 USD/百万tokensと地域加算10%を上回る0.3 microUSD/token、出力は0.75 USD/百万tokensと地域加算10%を上回る1 microUSD/tokenで予約する。既存生成の保護単価は変更しない。

`B`を要求JSONのUTF-8 bytes、`N=3`を`max_tool_calls`とすると検索予約は次の整数microUSD。検索context 128kを入力全体の上限とは解釈せず、記事・instructions・schemaを含む要求入力を各passへ追加する。

```text
ceil((128000 + B + 8192) * (N + 1) * 0.3 + N * 10000 + 6000)
```

検索料はsearchだけでなくopenも含む最大3call分を保守的に予約する。入力`B+8192 <= 128000`、出力（推論tokens含む）最大6000。校閲はtoolsなしで`ceil((B+8192)*0.3+6000)`。既存9生成予約647117 microUSDと通常量の検索・校閲が1 USD内に収まるfixture、および超過時の送信前停止を検証する。記事長や残月額によっては9言語が揃う前に停止する。完了を保証して上限を緩めない。2026-11-19 00:00 UTC以降は料金再確認まで停止する。

`migrations/0006_seo_research.sql`で既存jobへv1を付与し、`seo_editorial_checks`を追加する。`(job_id,phase)`の一意制約で検索と校閲の開始を一度だけ確保し、started/unresolvedを再送しない。同じ入力・complete・R2 hash一致時のみ保存済み結果を返す。期限後や終端runは再開しない。

非公開R2とD1の照合先:

- `seo_editorial_checks`: phase、call_id、input SHA、status、result SHA、開始日時。削除・retention処理は追加しない。
- `seo-responses/<call_id>.json`: API応答原本。検索操作・引用annotation・AI抜粋・具体的校閲issuesを含む。通常logやActions出力へ出さない。
- `seo-editorial/<job_id>/research.json`: source SHA、API response ID、確認日時、queries、URL/title/元主張/AI抜粋/支持判定。
- 同じprefixの`review.json`: 最終files SHA、確認日時、各pathのAI校閲結果。
- `research-failure.json` / `review-failure.json`: 固定code、call ID、原本R2 key、原本の保存確認結果。保存失敗でもD1のcall IDから原本keyを特定できる。`responseStored=false`は不明として扱い、原本がないことや未課金を推定しない。

不合格のissuesは上記原本から運用担当者が確認する。保存済み成果の修正方針は検討できるが、この経路には終端巻戻し・予算延長・ロック解除の機能はない。旧管理復旧helperの固定call数・next_step条件と異なる失敗を、旧proof形式へ当てはめて解除しない。

## 段階配備と受入

運用担当者が次の順で実施する。このPR作業ではmigration適用、配置、生成、dispatch、lock変更はしない。

現行SEOの`manual_editorial`はrun ID・実行時刻だけを受け付け、実収集の`report.candidates`をそのまま渡す。対象URLの手動指定契約はない。2026-10-20共有のtop3は非記事2件と観測中記事1件のため、通常canaryが全skipなら検索APIは未検証のまま。実収集で未ロックの適格記事が候補に入るまで待つ。それより前の限定実試験には、実資料・選定理由・run・sourceを監査保持する別の明示的な対象選択契約が必要であり、本実装には含めない。観測lock解除、report候補の直接書換え、既存claimのsite照合だけを利用した別記事への差替えは行わない。

1. CMS/SEOの差分・全CIを受入。実行中v2 jobがないことを確認し、`npx wrangler d1 migrations apply cms-ai --remote`で0006まで適用する（DB名は`cms-ai`）。本番状態・migration適用結果は非公開運用記録へ残す。
2. CMSをGitHub連携で配置し、`SEO_RESEARCH_ENABLED=false`、canary ID空の読戻しを確認する。通常CMS、現行週次Cron・既存観測lock・予算台帳を維持する。
3. 6対象repo（homepage-hatt、homepage-cherry、acecore-net、acecore-systems、aceserver-portal、aceserver-wiki）の`.github/workflows/seo-content.yml`にある`acecore-systems/cms-ai/seo-runner@<40SHA>`を、このCMS PRのCI成功commitへ更新する。inputは`run_id`/`job_id`のまま。各CI・mainのpin読戻し後に次へ進む。新runnerはv1も実行できる。旧runnerはv2のresearchがないため生成前に停止する。
4. 未ロック・open PR重複なしの記事と残run/月予算を確認し、新しい1つの`editorial-UUID`だけをcanary IDに設定する。全run flagはfalseのまま。通常のcoordinator `manual_editorial`でそのIDを一度だけ開始し、deadlineは開始から30分、Draftで止める。
5. 実APIで検索→open_page→citation＋strict JSONの組合せが成立するか、資料が実際の主張を支持するかを確認する。R2/D1、11call（検索1＋最大9生成＋校閲1、単言語は3call）、予算、source/最終hash、9言語本文、repo検証、Draft PR、callback、lockの一致を受入。mock passをこの確認の代用にしない。
6. 不明・失敗ならcanary IDを取り外し、全run flagはfalseを維持。旧runの終端・予約・lock・成果は保持する。新しいIDや自動再送で失敗を回避しない。
7. canaryの終端と受入を確認してからcanary IDを撤去し、全run flagをtrueへ変更してGitHub連携配置・読戻しする。既存月曜09:00 JSTとPC予約PAUSEDを維持する。

停止は全run flag=falseとcanary ID空で新規jobをv1へ戻す。作成済みv2 jobはv2のままで、途中でguardを外さない。進行中v2がある間はrunner/CMSを旧版へ戻さず、その終端を照合する。migrationはrollbackしない。統合・公開は定期処理へ追加しない。
