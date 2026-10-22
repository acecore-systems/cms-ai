# SEOの新規資料調査とAI校閲

## 2026-10-22 入力共有・工程予算再配分（実装検証、未配備）

原文・全9localeの旧文と最終文・共通/対象guide・根拠を落とさず、校閲入力の完全一致する段落だけを共有辞書へ1回保存する。各ファイルは順序付きの文字列と参照で構成し、追加separatorなしで全UTF-8文字列を復元する。送信前にserverで元文字列との完全一致を検証する。改行、空白、コードフェンス、条件、否定、URLを正規化しない。JSONに似た本文は文字列のままであり参照命令として解釈しない。校閲指示は参照部分も含む全旧文・最終文を読むよう明記し、全pathの意味/自然さ/根拠/具体的issues判定を維持する。原本・accepted成果・review-input・final hashの保存形式は変更しない。

researchありの生成指示は重複する工程・metadata説明を統合した英語主体の指示にし、共通guide全文と根拠JSONは保持する。原稿/対象guideを削除・要約せず、成功/エラーの対の手順、目的・条件・否定、語義/性数/一致、コード完全保持、正当なclarificationを維持する。通常CMSとresearchなしの従来指示は変更しない。英語への指示整理と参照表現をモデルが正しく扱えるかは実API未検証であり、ローカル可逆性を品質合格とは呼ばない。

生成だけ45,000 bytesへ内部再配分し、plan/search各16,000・review180,000、出力数・単価・1 USD/run・5 USD/JST月は維持する。`STAGE_INPUT_BYTES`を上限の正本として全12 APIの最大予約989075 microUSDを算定する。残額10925 microUSDは余裕であり追加再試行枠ではない。

claim前preflightは同一の生成job/prompt/schema/provider payload builderで全9段階も計測する。既知原本・対象guide・現指示と未取得の空根拠placeholderだけでも45KBを超える場合、非公開サイズreceiptを保存して既存skip経路で次候補へ進む。claim/有料API予約より前であり、保存失敗は停止する。receiptは全既知filesのhash・全9path/locale/bytes・上限・理由を保持する。research contract1のeligibilityは変更しない。実取得根拠・日本語改訂・翻訳の増大は予測できず、baseline適合は実生成成功の保証ではない。実送信の最終JSON bytesを再検査し、生成45KB/校閲180KB超過は従来どおりfail closedで止める。

保存候補と現mainの全files一致は運用担当者が確認済み。実builderに合成plan/evidence/fetchを用いた計測（有料API0）は次のとおり。baselineは旧文と未改訂最終文が一致して共有率が高いため、実改訂後の校閲サイズは再計測が必須。

| 自然候補                      | 校閲旧→共有後 bytes | 既知生成最大 bytes | 合成根拠込み生成最大 bytes | 合成全工程予約 microUSD | 判断                              |
| ----------------------------- | ------------------- | ------------------ | -------------------------- | ----------------------- | --------------------------------- |
| 1/3 Systems Astro SEO         | 227403→146252       | 45702              | 46201                      | 917413                  | 生成上限超過、claim前に無課金skip |
| 2 Systems AI chat link safety | 208868→128798       | 42462              | 42927                      | 905215                  | 合成計測内、実根拠/改訂増大未確認 |

候補2の合成生成余裕は2073 bytes。既存月予約3653608に最大989075を加えて4642683 microUSDで月5USD内だが、これは後日の実行承認や最新残額の代用ではない。原稿切捨て・任意URL入替・lock解除・未知状態解放は行わない。非公開計測はSEO root `.local/research-input-fit-20261022/`、元保存原本は `.local/research-e2e-20261022/`に保持する。今回サーバー側だけの変更でmigration/OIDC/runner protocol変更はなく、6repoのpin更新は不要。merge/配備/有料canaryは運用担当者の受入後に判断する。

2026年10月20日の利用者指示による追加。通常CMSの会話・生成APIは変更しない。新機能は無効を維持。前回の限定実APIはcompleted/insufficient・open1・citation0で生成前停止した。その後の実APIでは検索・open・引用・claim ID形式は成立したが、選択主張と検索主題の不一致によりinsufficientで停止した。下記の固定plan方式は実API・クラウドE2E未確認。テストで用いる検索応答、出典、校閲結果は合成fixtureであり、実資料の取得成功や記事品質の証明ではない。

## 生成前の意味・文法点検（2026-10-22）

SEO専用生成指示で、原文の事実・条件・否定・手順と目的を出力前に対応確認し、成功時とエラー時など対になる確認を両方保持する。翻訳では改訂済み日本語との意味対応に加え、冠詞・名詞の性数・主語と動詞の一致・語義を点検する。原文にない手順や目的を補わず、不明な場合のclarificationも維持する。以前の校閲が検出した手順脱落・文法問題の予防指示であり、実際の校閲passを保証しない。

独立AI校閲の判定、失敗応答と具体的issuesの非公開保存、再送禁止は変更しない。追加API呼出し・予算上限変更・runner protocol変更はなく、6サイトのrunner pin更新は不要。合成応答による回帰成功と、実際の研究・生成・AI校閲・Draft PR成功を区別する。

限定実行前には最新の自然候補のmain・9原稿・guide・PR重複・lockと、実builderのrequest bytesを再確認する。原本だけでbaseline review上限180000 bytesを超える場合は既存のclaim前preflightでskipし、有料調査を開始しない。合成plan/資料を用いたrequest計測はサイズ検証だけであり、資料取得・主張支持・翻訳品質の証拠ではない。全候補が不適格ならURL差替え、本文切捨てによって実試行へ進めない。

本番の旧runnerでは校閲failがunresolvedとなり、専用管理監査による照合を要する。下記の新しい校閲拒否終端は配備受入待ち。生成前の確定insufficient用callbackは流用しない。

## 実行と根拠

新規jobの作成時にprotocolを固定する。`SEO_RESEARCH_ENABLED=true`、または完全一致する`SEO_RESEARCH_CANARY_RUN_ID=editorial-UUID`のjobだけv2。既存jobと初期無効時はv1を保持する。Service Bindingのstart/status、OIDC audience・repository・workflow、main/source hash、claimとDraft終了の契約は維持する。

v2は対象Actionsがsource・open PRを確認して中央claimを取得した後、次の順に進む。

1. `research {}`内部で、まずLunaのtoolsなしplannerを1回実行し、原文のclaim ID・必要条件の完全一致抜粋・anchor・自然な検索queriesを固定して非公開R2へ保存する。その後、別call IDで対象段落とplanだけを検索へ渡す。共用認証をWorker内だけで利用し、新providerや追加認証は使わない。
2. 既存本文の1主張と、その主張を支持する未掲載の一次資料1件に対象を絞る。最大3回のhosted `web_search` callで検索とページ取得を実施する。1回のResponses要求内で、引用付き自然文の根拠説明と末尾の単一JSONコードブロックを返す。検索query、検索で発見したURL、完了した`open_page`、`url_citation`、構造化結果の支持判定が揃うことを確認する。最低1つは正本に未掲載のURLでなければ停止する。単なる既存URL再取得、検索結果要約のみ、資料不足・反証・不明は成功扱いしない。
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

検索料はsearchだけでなくopenも含む最大3call分を保守的に予約する。入力`B+8192 <= 128000`、出力（推論tokens含む）最大6000。計画・校閲はtoolsなしで`ceil((B+8192)*0.3+6000)`。下記の段階別serialized request上限と送信前停止を検証する。記事長や残月額によっては9言語が揃う前に停止する。完了を保証して上限を緩めない。2026-11-19 00:00 UTC以降は料金再確認まで停止する。

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

現行SEOの`manual_editorial`はrun ID・実行時刻だけを受け付け、実収集の`report.candidates`を渡す。通常の候補生成は記事routeと既存lock（Hattは最終gate）で事前選別し、最大3件と最終CMS照合を維持する。対象URLの手動指定、観測lock解除、偽候補注入は行わない。有料試験前に新しい実収集候補・main/source・open PR・lock・残予算を確認する。今回のローカル入力計測に使った旧記事が次の適格候補であるとは限らない。

1. CMS/SEOの差分・全CIを受入。実行中v2 jobがないことを確認し、`npx wrangler d1 migrations apply cms-ai --remote`で0007まで適用する（DB名は`cms-ai`）。本番状態・migration適用結果は非公開運用記録へ残す。
2. CMSをGitHub連携で配置し、`SEO_RESEARCH_ENABLED=false`、canary ID空の読戻しを確認する。通常CMS、現行週次Cron・既存観測lock・予算台帳を維持する。
3. 6対象repoの既設v2 runner pinとmain反映を確認する。今回の固定planはCMSサーバー内部の変更でrunner protocolを変えないため、6repo pin更新は不要。初期v2配備前の旧runnerはresearchがないため生成前に停止する。
4. 未ロック・open PR重複なしの記事と残run/月予算を確認し、新しい1つの`editorial-UUID`だけをcanary IDに設定する。全run flagはfalseのまま。通常のcoordinator `manual_editorial`でそのIDを一度だけ開始し、deadlineは開始から30分、Draftで止める。
5. 実APIで検索→open_page→自然文の実citation＋末尾JSONの組合せが成立するか、資料が実際の主張を支持するかを確認する。R2/D1、11call（検索1＋最大9生成＋校閲1、単言語は3call）、予算、source/最終hash、9言語本文、repo検証、Draft PR、callback、lockの一致を受入。mock passをこの確認の代用にしない。
6. 不明・失敗ならcanary IDを取り外し、全run flagはfalseを維持。旧runの終端・予約・lock・成果は保持する。新しいIDや自動再送で失敗を回避しない。
7. canaryの終端と受入を確認してからcanary IDを撤去し、全run flagをtrueへ変更してGitHub連携配置・読戻しする。既存月曜09:00 JSTとPC予約PAUSEDを維持する。

停止は全run flag=falseとcanary ID空で新規jobをv1へ戻す。作成済みv2 jobはv2のままで、途中でguardを外さない。進行中v2がある間はrunner/CMSを旧版へ戻さず、その終端を照合する。migrationはrollbackしない。統合・公開は定期処理へ追加しない。

## 引用形式の限定修正（実API未確認）

保存済みの前回応答は3主張を挙げたが、実open_pageは1件、url_citationは0、最終verdictはinsufficientだった。既存最大3tool callsでsearch1＋3openは不可能だが、実際は2callsで終了したため上限だけを原因とは断定しない。strict JSONがcitation生成を抑制した可能性も仮説であり、[公式検索仕様](https://developers.openai.com/api/docs/guides/tools-web-search)は通常の引用annotationを説明する一方、この組合せの保証は確認できていない。

今回の修正は1callのまま、1主張・新資料1件を自然文で根拠説明し、実inline引用の後に末尾JSONを返す。検索時のtext.formatをtextへ変更し、CMSでJSONの全キー・型・判定値・最大1sourceを検査する。採用URLは検索discovered・明示open・自然文範囲内のprovider url_citationの全てに一致し、claimは元本文の連続原文、未掲載の安全なHTTPS URLであることを維持する。手書き引用やJSON中のURLだけでは合格しない。reviewは従来のstrict JSONのまま。

最大3tools・出力6000・既存予約式・同一run/月上限・絶対期限・再送禁止を変更しない。費用は修正後のinstructionsを含む実要求bytesで再計算するため、予約額が前回と同額になる保証ではない。根拠不足は引き続き停止する。旧raw応答と同じ構造、引用欠落/JSON内だけのannotation、複数source・余分なキー・不正な末尾を拒否するローカルfixtureは実API成功の代用ではない。

変更はCMSのresearch要求/受入に限定し、既存runnerのresearch応答version1・source hash・sources契約は維持する。今回の変更自体に6repoのrunner pin更新は不要。保存済み旧run・監査・記事lockへ適用せず、新しい親確認済みcanaryだけで実API成立を確認する。生成後全言語校閲・Draft PRの実受入前に全run enableへ進めない。

## claim ID と既存 URL の境界

調査入力には正本本文の paragraph AST offset から切り出した `claims`（`id` と元の `markdown`）、既存リンク・本文中 URL の `existingUrls` を渡す。モデルは `claimId` だけを返し、CMS が同じ source hash の原文へ対応付ける。強調、inline code、句読点を strip して比較を緩めない。不明 ID・旧 claim 文字列形式・既存 URL は拒否する。12〜800文字の段落だけを選択対象とし、コードブロックを主張として選ばせない。根拠の適用条件は段落全体について確認する。

前回の実 API は search/open/url_citation まで成功したが、既存 URL と Markdown claim 不一致で生成前停止した。この変更のローカル回帰・CI は新しい有料実試験の成功を意味しない。予約額は増えた入力 bytes を既存計算式に含め、1 USD/run・5 USD/JST月と30分期限を維持する。新試験は新 run とし、旧 call を再送しない。runner protocol と出力 ResearchEvidence.claim は変更しないため6サイトのpin更新は不要。

## 固定plan方式（今回の追加、実API未確認）

直近の実試験は原文の無料個別証明書の主張を選びながら別時期のDedicated証明書を検索し、取得したchangelogでは必要条件を支持できずinsufficientとなった。検索途中の主張変更を防ぐため、Luna no-tools plannerのstrict JSONを先に保存し、検索には他のclaimsや記事全文を渡さない。検索・引用・新規一次資料・支持判定の基準は維持する。

plannerは原文段落ID、条件quote（12文字以上）、原文由来anchor（3文字以上）、自然なquery（最大2つ）を返す。quote/anchorの一意な原文substringをサーバーで解決し、条件offsetと原文段落全体を固定する。LLMへoffset計算を要求しない。各queryは全anchorを含み、英語keywordも使用できる。条件全文のqueryへの連結は要求しない。段落は切り詰めず、範囲外文脈や曖昧な指示語が必要ならplannerはinsufficientとする。queryと主張の意味的対応、公式性、実資料による支持はAI判断の限界として残る。

検索responseの実action.queriesは固定plan.queriesと完全一致する文字列だけを許可し、選択claim IDの変更も拒否する。provider側の言換えはfail closed。これは実APIが必ず同じqueryを使用するという保証ではなく、既知の主題変更・query rewriteのfixtureを拒否する契約である。

### 永続性と配備

`0007_seo_research_plan.sql`は既存check全列を保持してphaseにplanを追加する。運用担当者が無効状態・実行中v2なしを確認しmigrationを適用してからCMSをGitHub連携配置する。runner protocol/ResearchEvidenceは変えないため、この変更に6repo pin更新は不要。

- 各phaseの開始時にD1で一意call IDを確保し、`seo-editorial/<job_id>/<phase>-call.json`へinput hash・raw response key・result key・plan manifest keyを保存してからAPIを呼ぶ。
- `plan.json`はsource hash・claim ID・原文・条件offset/quote・anchors・queriesを保存。検索のinput hashはこのplanとsource hashに固定する。
- planner/searchは別call ID・別予約。同一budget run/絶対deadlineを使う。途中停止でもD1と各manifest、`<phase>-failure.json`から両方の原本へ到達できる。raw response未保存は不明であり未課金の証明ではない。
- completeかつ入力/result hash一致時だけ保存結果を利用する。started/unresolved・期限後・終端runは再送しない。旧方式のresearchが存在してplanがないjobへ追加plannerを送らない。
- 生成前拒否の管理照合は全plan/research call・予約・原本・manifestを列挙する。旧単一callのproofへ押し込まず、SEO監査のexact CAS/immutable guardを維持する。自動復旧は追加しない。

### 全工程予約の上限

以下は各段階の最終要求JSONのUTF-8 bytes上限。入力だけでなくinstructions/schema等を含み、超過時は予約・送信前に停止し、本文を切り詰めない。生成の追加上限はresearch v2だけに適用し、通常CMS/v1は維持する。

| 段階                          | bytes上限 | 最大予約microUSD |
| ----------------------------- | --------: | ---------------: |
| planner、toolsなし、出力6000  |     16000 |            13258 |
| 検索、3tools、4pass、出力6000 |     16000 |           218631 |
| 生成、出力12000、9回          |   各45000 |           694728 |
| AI校閲、toolsなし、出力6000   |    180000 |            62458 |
| 合計12 API calls              |           |       **989075** |

生成1回は既存保護単価で`45000+8192+12000*2=77192`、検索は上記式で各passに入力bytesを加算。1 USD内に10925 microUSDの差がある。月残額不足・期限・実生成後の入力増大には従来どおり停止するため、全記事完了を保証しない。

保存されたSystems記事（9言語＋7559 bytesのguide）を実request builderへ渡し、合成plan/根拠と既存本文でローカル計測した。planner5518 bytes、検索4317 bytes、校閲106134 bytes、生成各21103〜29063 bytesで全上限内。予約合計785066 microUSD（9生成530044）だった。計測receiptは非公開運用記録の`planning-full-sizing.json`/`planning-generation-sizing.json`に保存。新しい生成結果、実検索品質、AI校閲passの証明ではない。

2026-10-20 05:35:15 UTCの運用担当者による監査復旧はglobalActiveRows=0、元run partial、全6locks・予算・期限・根拠・旧audit不変を確認済み。新researchは無効を維持する。旧監査結果をこのplan方式で再解釈しない。確定insufficientを通常の安全な終端として扱う将来契約は別途設計判断が必要で、現在は管理復旧なしにglobal受付が維持されると称さない。unknownや生成後失敗の自動解除は本変更に含めない。

## 新jobの文単位根拠と確定insufficient終端（contract 2）

0008適用前のjobはresearch_contract=1のまま。新規research jobだけ2を指定する。plan.version=2では、サーバーが段落を完結文へ分け、選択可能なexact文をcontextPartsに示す。本文を二重に渡さず、すべてのpartsを連結すれば元段落に戻る。条件や否定を落とした任意substring、複数文、Markdownリンク/inline codeの途中境界を許可しない。モデルはtargetQuoteを1つ選び、条件quoteとanchorはその文内へ限定する。canonical evidence.claimはそのexact文であり、段落の他fact/提案を検証済みとしない。意味上の条件が前後文脈にある場合は文脈と合わせて検証し、不足はinsufficient。事実と推薦の意味的区別はAI判断を含み、人の確認済みとは称さない。

新上限で保存mainの自然候補3件をローカル計測した。Portal先頭候補はplanner12464/search4366/review157848 bytes、生成最大37584 bytes、合成根拠で856319 microUSD。3番目は全上限内852587。2番目はreview227403 bytesかつ一部生成40000超過のため不適格。これは本番AI出力や検索成功の証明ではなく、生成後の膨張時は送信前停止する。

確定insufficientだけ次の専用経路を使う。通常の契約違反、raw未保存、応答不明、生成/公開開始後、PR/ref存在は従来unresolved。

1. CMSはplanのみ、またはplan+searchの全callがbudget complete/API completedで、最後の厳密な結果がinsufficientであることを原本から再検証する。ready plan、固定query/claim、全manifest、raw SHAを確認し、非公開rejection-offerを保存する。verified空配列をinsufficientへ読み替えない。
2. 新runnerはOIDCで結び付いたjobのmainを再照合し、固定branch refと当該headの全状態PRをページングして不存在を確認する。成功時だけresearch-rejectへ空ref/PR集合とoffer hashを渡す。ここから生成/pushは実施しない。
3. CMSは同source/hash/base/Actions run、期限内、next_step0/call_id null、生成予約/成果0、不可逆generation_started/publication_startedとも0を確認。R2原本と全callを再検証しimmutable receiptを保存後、D1 triggerが原子的に内部run/jobをterminal unresolvedへ固定する。専用receiptと成功callbackがあるstatus APIだけresearch_rejectedを返す。内部unresolved行単独を結果不明や復旧必要と判定しない。
4. 専用Service Binding callback rejectResearchはreceipt hash、call一覧、source、owner、旧run/editorial/lockのexact snapshot CASを確認。SEO追加migration0006のtriggerでglobal runだけcollection_statusへ終了し、hold1/retained/deadline/全記事lock/根拠/費用を保持する。元finished_atがnullならdecisionTimeを記録し、既存時刻は保持する。旧管理auditへ追記・変更しない。
5. 同receipt再通知は冪等。異なるreceipt・late draft callback・期限延長・再開・台帳削除を拒否する。callback通信不明はglobalを解放せず、status照合で同じ保存済みcallbackだけ再通知する。新planner/検索の再送はない。生成結果不明を解除する経路ではない。

新job用receiptはD1 seo_research_rejectionsとprivate R2 seo-editorial/<job>/rejection.json。source/raw/manifest/call hashを含む。SEO側runtime_research_rejectionsは対応receiptと元全行snapshotを保持し、retentionで削除しない。これは通常の確定拒否の監査であり、旧research_rejection_auditによる手動復旧とは別契約。

配備順: research無効・canary空を確認 → 運用担当者がSEO0006/CMS0008を旧行保持照合付きで適用 → SEO callback/WorkflowとCMSを配置 → 6repoのseo-content.ymlを本PRのCI成功40SHAへ更新・CI/main確認 → 最新候補/予算/lockを再確認。新有料run/全run enableは今回実施しない。6pinが旧版の間、新contractのinsufficientは安全側のunresolvedで終了するため、canaryを起動しない。

## 原本サイズの事前適格判定

research contract 2 の新jobは、claim・API予約前に既存builderでplan requestと未改訂の全原本を使ったbaseline review requestの最終JSON bytesを計測する。上限はplan 16,000 bytes、review 180,000 bytes、全9generation各45,000 bytes。reviewの資料は`not_acquired_size_estimate_only`と明示する空の最小placeholderであり、実証拠や校閲合格ではない。

非公開R2の`seo-editorial/<jobId>/eligibility-preflight.json`へbase/source/bundle SHA、計測bytes・上限・理由を保存する。原本時点で超過する場合は既存skip経路で次の自然候補へ進み、記事lockとAI予約を取得しない。保存に失敗した場合は停止する。候補上限3件、旧contract 1、最終CMS gateは維持する。原文を切り捨てない。

baseline適合は生成後の容量を保証しない。実資料や改訂による増大は従来の各stage上限でfail closedとする。runnerの既存claim skipped処理を利用するためrunner変更・6repo pin更新・migrationは不要。

### コードフェンスの保護

実canaryで、言語指定のない開始フェンスへ`text`を補完した提案を`seo_code_changed`で拒否した。コード本文が同じでも開始フェンス・言語指定を含む完全一致が必要である。新規研究あり／なし両方の生成指示へ、この契約を明示する。guardの緩和や保存提案の書換えは行わない。保存実応答のローカル再現と拒否回帰を確認したが、指示追加はモデル遵守を保証せず、実生成での成功は未確認である。

## 確定した校閲拒否の通常終端

新runnerは9言語すべての受入・サイト検証後、AI校閲が明示的にfailと具体的issuesを返した場合だけ専用`review-reject`へ進む。CMSはplan/search/generation9/reviewの全12callがcompleteであること、保存原本・proposal・step-call manifest・9成果・校閲対象最終bytes・raw responseのhashを再照合し、非公開R2へimmutable receiptを書き込み再取得する。既存jobでmanifestが欠ける場合、校閲の形式違反・timeout・保存失敗・不明結果の場合はunresolvedを維持する。レビューを再送して合格させる機能ではない。

runnerは同一OIDC run/base、最新main、自動branchのrefと全状態PRの不存在を確認する。publish前のこの経路はcommit/push/PR作成へ進まない。CMSの`seo_review_rejections`とSEOの`runtime_review_rejections`は独立したappend-onlyテーブル。CMS jobはunresolved/accepted9/publication_started0のまま、SEOはexact snapshot CASでglobal runのみ元collection_statusへ終端化する。全article lock・期限・hold・予算・根拠・旧管理監査は保持する。finished_atが既にあれば保持、未記録なら固定decisionTimeを記録する。CMS statusはcallback記録後に`review_rejected`とreceipt hashを返し、WorkflowはSEO側receipt一致を確認する。

同receiptの再照合は冪等、異なるreceipt・late draft callback・run再開は拒否する。失われたcallback応答は既存statusの同receipt再照合で扱い、AI callを追加しない。保証対象は9言語・新manifestが揃うcontract2だけ。それ以外は従来のunresolvedとして運用担当者が確認する。

配置は既存全行比較付きでSEO migration0011→SEO専用callback対応Worker→CMS migration0009→CMS対応Worker→6サイトの新runner固定SHAの順。CMSはmain統合による自動Workers Buildより先にmigration0009を適用する。research=false/canary空・通常Cron・既存予算を維持して段階配置する。旧runnerは新offerを成功と扱わず停止するため、全6pinのreadback前に有効化しない。schemaをdown-migrateせず、障害時は新researchを無効にして保存receiptだけを照合する。今回のPRでは配備・migration適用・実API・実runtime receiptは未確認。
