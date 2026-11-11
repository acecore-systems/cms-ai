# CMS Muse Ember 移行確認

2026-11-11 に Meta Chat Completions へ合成データだけを送信し、CMS の `changes` と `maxItems: 20` を含む strict JSON Schema、system・user・assistant の履歴、赤と青の合成 PNG 2 枚を確認した。`muse-ember-1.0`、`reasoning_effort: medium`、`max_tokens: 12000`、`store: false` の条件で HTTP 200、画像の順序に合う Markdown 差分を受信した。使用量は入力 208、出力 341 tokens、所要 4.3 秒。

この試験は直接 API の合成入力であり、Cloudflare の本番 binding、CMS のサイト連携、実データの品質、本番配備を証明しない。`client/` は各サイトへ vendor するため、配備前に対象サイトの画面反映を確認する。SEO の切替は別途扱い、既存の Haiku ジョブと認証を維持する。
