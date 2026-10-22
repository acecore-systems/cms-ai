# URL許可説明の新job版

trial4は検索原本にqueryなしのMinecraft Help公式URLを含んでいたが、モデルはLearn形式に該当しないことを理由にinsufficientとした。URL validatorはそのHelp URLを既に許可しており、保存された不足判定は変更しない。

`reference_policy=2`はそのままに、`url_instructions`を独立して永続化する。旧jobは1、新jobは2。版1はdiscovery/retrieval requestを従来どおり再構成する。版2は「queryなしの安全な公開HTTPS URLは従来どおり対象、Learn制限はquery付き例外だけ」と説明する。これは公式性・主張支持の保証ではない。検索原本との完全一致、固定open/citation、既存URL・自サイト除外、全条件支持は維持する。

## 保存と互換性

- migration `0021_seo_url_instructions.sql`で旧全列を保持し、default1、更新禁止triggerを追加する。既存jobを2へ変更しない。
- discovery/research checkの入力hashに新指示版を束縛し、preflight保存値とpropose時job値を比較する。異版再入は追加API前に拒否する。
- evidence/Discoveryの形式、reference_policy、receipt版、runner validatorは変更しない。6siteのf5004b5 pin再更新とSEO migrationは不要。
- CMSコード配備より先に0021を適用し、旧行比較・default/immutableを読戻す。本番作業は運用担当者が行う。

## 検証境界

保存実応答の旧insufficient拒否と、旧requestの完全一致を無課金で確認する。新説明でモデルが正しく選ぶこと、取得資料が条件を支持すること、生成・校閲・Draftまでの成功は実API未検証。今回API追加0。予算・cap・API回数・本文/9言語の条件は変更しない。
