# 404になった公式資料の限定復旧

新jobの`seo_source_recovery_contracts.version=2`だけに適用する。従来jobはversion1となり、追加HTTP取得も既掲載資料の例外も行わない。旧jobへの後付け、契約・証跡hashのupdate/delete/replaceは禁止する。

## 背景と例外の範囲

2026-10-24の保存済み失敗では、検索で選定された公式2URLが404となり根拠確認を終了した。現行の上位Setupページには説明があるが、そのURLは原稿の既存リンクでもあった。一般の既存URL禁止を維持したまま、新jobでは次の全条件を満たすURLだけをfresh本文の再検証に使える。

- planとdiscoveryは従来どおり。今回の検索で発見した、記事未掲載の選定URLから開始する。
- 既存の公式publisher許可範囲内で、実HTTPの404/410が連続した場合だけ同一originの上位パスへ進む。Geyser固有の復旧先は実装しない。
- 上位URLが非空HTMLの200を返し、取得時刻・原稿SHAに結び付くdiscovery SHA・各hopのstatus・bytes・到達本文SHAを保存できた場合だけ候補を置換する。これは上位候補の取得証明であり、HTTP redirectやcanonical宣言の証明ではない。
- 同じURLへ到達した2候補はdedupする。実researchは固定先を改めてopenし、全条件・否定・時点・文脈の支持とAPI引用を要求する。200や古い検索snippetだけでは支持と扱わない。
- 既掲載URLの例外は上記の来歴を検証して作った内部オブジェクトだけが持つ。runnerのJSONから`allowExisting`を指定する口はない。一般の既掲載URL、異なるorigin、自己サイト、証跡不明の資料には例外を適用しない。

## 上限と保存

HTTPは最大8要求、各候補で上位3段階まで、1本文256 KiB、合計1 MiB、全体10秒と元deadlineの小さい方、各要求最大3秒。streamがbyte上限を超えた時点で中止し、完全取得した本文と扱わない。認証情報は送らず、全redirectをmanualで拒否する。403・timeout・不明通信・非HTML・空本文でも上位探索を続けない。未知の結果は元の選定URLを保持し、復旧成功としない。

`seo-editorial/<job>/source-recovery.json`を条件付きputで保存し、そのSHAを`seo_source_recovery_results`に一度だけ記録する。原discovery、原稿、旧receiptは変更しない。researchのrequest hashには固定取得先が入り、既掲載例外時には証跡SHAも入る。採用した例外URLと証跡SHAはresearch evidenceへ保存し、生成・校閲・公開許可・不足/校閲拒否receiptの再検証でも同じD1/R2証跡を確認する。

生成では既存の事実だけを扱い、新仕様や新事実を追記しない。例外URLは日本語と全localeに適切な説明とともに保持し、見かけ上の新規リンクのための重複追加は求めない。現行本文と意味保持が両立しなければ拒否する。AI校閲、数値・コード・metadata保護、Draft限定は継続する。

providerの検索1回・research最大2open、予約上限、月12.10ドル（2026年10月）/通常7ドル・1回1.25ドル・10月26日留保1.25ドル・元の30分期限は変更しない。復旧失敗後の追加AI呼出しや再試行は追加しない。

## 検証と未検証

- 保存済みの既存Setupリンクを含む原稿を変更せず、保存失敗応答のinsufficientを実parserで再現。親の実HTTP確認では両旧URLから現行Setupへ復旧し、fallbackはdedupでnull。取得本文115,005 bytes、SHA256 `7fb1a0fd69c6173b02ffeb862e647d7f11fdf128cd0631df049cca847ded7a27`。
- 同じ保存原稿・discovery・取得HTMLを使ったnetwork-denied再生では、手組planとfake provider応答を実parserに渡した。既存リンクの例外が通り、research requestは5,469 bytes、現行8,000 bytes上限内。これは本番モデルの支持判断・文章品質を実証しない。
- 統合テストは既掲載リンクを残し、実`SeoRunner`→CMS request handler→根拠parser→9locale生成受入→実`assertEditorialFiles`→AI校閲receipt→公開許可→Draft要求まで通す。成功はDraft POST1件、同じrunnerの再実行でも増えない。無関係本文、校閲拒否、生成前/校閲前/公開前/拒否receipt前のproof改ざんはDraftを作らない。
- HTTP/AI/GitHub応答とコマンド実行はfake。整形は実Prettier、CMS/runnerの内容・許可path・全locale・receipt検証は実装を通す。サイトrepoのnpm検証コマンドはstubであり、実際のサイト検証成功・本番AI生成成功・本番Draft作成とは区別する。
- SSRF対象、非許可origin、redirect、unknown/403/500、サイズ・期限超過、偽の既掲載許可、改ざん、既掲載URLから直接開始を拒否。旧sourceRecovery1は追加HTTP0、従来再生を維持する。
- CMS全体723 passed / 1 skipped。skipは既存`CMS_CANDIDATE_REPLAY_DIR`未設定のtrial7/10/14/15私有原稿再生。今回の私有原稿再生は上記の別検証で実施した。
- 保存本番snapshotをSQLiteでreplayし、旧371行・169既存schema objectの不変を確認。実Miniflare/workerd D1で監査先行INSERTとjob INSERTの同一batch成功、orphan batch rollbackを確認した。

## 配備順序

1. 親が最新snapshot・reviewed commit・CIを照合し、追加migration `0036_seo_source_recovery.sql`を適用する。既存schemaの変更はない。
2. migration適用後にCMSをmerge/deployする。Git push buildで自動deployされるため、mergeを先行しない。
3. 本番version・受付・予算等のreadbackを親が確認する。今回の実装担当は本番write・merge/deploy・有料AIを実行しない。

runnerの通信契約・ソース・6サイトworkflow pinは変更不要。追加有料実確認は今回行っておらず、本番AI品質成功は未確認である。
