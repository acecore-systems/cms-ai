# CMS Muse Ember 移行確認

2026-11-11 に Meta Chat Completions へ合成データだけを送信し、CMS の `changes` と `maxItems: 20` を含む strict JSON Schema、system・user・assistant の履歴、赤と青の合成 PNG 2 枚を確認した。`muse-ember-1.0`、`reasoning_effort: medium`、`max_tokens: 12000`、`store: false` の条件で HTTP 200、画像の順序に合う Markdown 差分を受信した。使用量は入力 208、出力 341 tokens、所要 4.3 秒。

同じ合成入力を Cloudflare の遠隔開発プレビューでも実行した。本番と同じ Secrets Store binding と CMS アダプタで、入力 208、出力 362 tokens、所要 2.9 秒で期待どおりの差分を確認した。

各サイトへの `client/` 配布と本番 CMS の操作は配備後の確認項目。SEO の既存 Haiku ジョブには保存済みの契約を適用する。
