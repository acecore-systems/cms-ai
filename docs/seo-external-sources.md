# 外部資料選定policy v4

従来v3では原文に相対`/`があっても絶対URLの自サイトtopは既存URLと一致せず、検索・取得・引用・支持が成立すると採用できた。これを第三者外部資料の発見とは扱わない。v4は新jobだけで自サイトと既存参照先を除外する。

## 新jobの境界

- `sites.ts`のsite設定と正本path/slugからcanonical正本URLと明示されたhost aliasをサーバーで組み立てる。providerからoriginを受け取らない。
- 原稿の通常リンク・参照リンク・自動リンクを読み、相対・protocol-relativeを正本URL基準でabsoluteへ解決する。fragmentを除いた文書単位の同一性は**除外判定だけ**に使い、queryやmirrorを恣意的に同一視しない。
- 同siteのcanonical host・設定済みexact aliasと既存参照先は新規資料にしない。別hostであることだけで第三者性・公式性を保証しない。未登録の運営関連hostを機械的に判定する機能は追加していない。
- plannerにも対象site/既存参照先を渡し、固有の自サービス宣伝・参加案内を選ばず、外部一次資料で確認可能な原文exact事実文を選ぶよう指定する。原文の条件・否定・文脈は削らず、選べなければinsufficient。
- discoveryは同じ除外情報を使用し、返却JSON、raw search集合完全一致、安全URL条件を検証する。選択した結果が自サイト/既存/unsafeだけなら正常insufficientとする。検索集合にないURL捏造・曖昧JSON・不完全原本は従来どおり拒否する。
- 採用URL→open_page→provider citationは元のURL文字列の完全一致を維持し、後段の公式性・全文支持/条件確認は必須。検索snippetを採用根拠にしない。

## 保存・後方互換・配備

0016で`seo_editorial_jobs.external_sources`を追加し、既定0・変更禁止とする。旧v1–v3のplan/request/保存原本・再照合は変えず、新jobだけ1を明示保存する。既存discovery_policy列は変更しない。有効policyは新jobだけ4となり、plan/discovery入力hash、DiscoveryのexternalScope/selectionReason、preflightとproposeのpolicy照合に束縛する。

不足receiptの再検証にもscopeを渡す。plan/discovery/researchの完成原本が確定した不足だけ従来の正常終端へ進み、unknownや契約違反を解除しない。receipt形式・API数13・SEO台帳契約・runner入出力は変更しないためSEO migration/6site pin更新は不要。

運用担当者は0016をコード配信前に適用し、旧全列保持/default0を確認する。本番write・有料実試行はこの実装のローカル検証には含めない。scopeは研究phaseだけで、generation payload/割当/校閲入力は不変。1.25 USD/run・月例外・全工程最大1205876 microUSD・出力12000・30分・Draft終了を維持する。

## 無課金の確認範囲

保存済み実v3応答は旧policyで完全一致再現し、同じ応答をv4に仮適用すると自サイトとしてinsufficientになる。これは旧runの結果変更や本番再実行ではない。

最新minecraft-play-with-friends候補はplan28918/32000 bytes、baseline校閲223342/500000、既知9生成489647/525000。全9段落変更＋10%増量の合成入力は校閲404671、生成520493で適合するが、翻訳の最小余裕106 bytesは小さい。実取得根拠と改訂の増分による停止リスクは残る。原稿切詰め・上限拡大・品質緩和はしていない。

9原稿はfrontmatter・8翻訳sourceHash・段落/見出し/リンク役割が対応し、内部リンクのlocale化とkoかな0を確認した。引用した合成title変更で9件の受入/整形意味同一/最終hash検証が通り、不正metadata・新数値・コード・未確認URL・重複keyは拒否した。AI生成・意味校閲・Draft成功や対象サイト全buildの証明とは区別する。
