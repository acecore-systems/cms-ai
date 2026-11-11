# CMS Muse の推論強度

Muse Ember の指定値は `minimal`、`low`、`medium`、`high`、`xhigh`、`max`。`none` は使わない。相談専用の新規会話は `low`、編集可能な権限は `medium` を初期値とし、明示した値と会話の履歴を維持する。推論 token は出力枠に含まれ、深さを上げると所要時間や出力消費が増えうる。

`0050_cms_muse_effort.sql` は既存の `cms_ai_jobs` に nullable な列を追加する。古い列と旧 Worker の互換性のため、`minimal` は `low`、`xhigh` は `high` を古い列に保存し、追加列の実値を優先して読み直す。他の値と既存行は追加列を NULL にする。DB の CHECK は両列の対応を検証する。旧 Worker が migration 後に作成する行も追加列が NULL で従来どおり扱える。

本番適用では先に D1 migration を実施・確認し、次に新 Worker を反映する。新 UI の4サイトは Worker の受入後に配布する。旧 Worker への復帰では新値を含む未完了ジョブが互換の `low` / `high` として読まれるため、そのようなジョブを完了・停止してから戻す。migrationの削除、履歴・添付の破棄は行わない。

旧 `SeoGeneration.propose` は未プロファイルの Luna への送信経路だったため停止する。旧 SEO ジョブの読み取りは残し、旧検索 provider での新規開始や runner 更新は拒否する。過去の監査値や証跡の名前は変更しない。正常な Parallel v5 ジョブの契約はそのまま維持する。
