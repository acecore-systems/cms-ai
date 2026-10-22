# SEO内部生成と費用上限

2026-10-23の利用者明示承認により、新規jobは1.25 USD/run・7 USD/JST月とする。配備前に`0012_seo_run_budget.sql`を適用する。旧予算runは`run_limit_micros=1000000`、旧jobは`budget_version=1`で保持し、保存済み配分を新poolへ再計算しない。新jobのversion2だけrun上限1250000、全工程最大1205876 microUSDを使う。上限列とjob版はimmutableで、異なる版による既存runの予約を拒否する。単一callの100万microUSD制約は従来どおりで、全工程のrun合計上限とは別である。

旧全行・予約・監査は更新しない。0012適用前後で旧列を完全比較し、追加列のdefaultを確認した後に新コードを配置する。新job作成後は旧コードへ巻き戻さず、必要なら既存flagで停止する。通常CMS・月境界・30分期限・unknown予約保持は不変。以下は以前の承認・実装経緯。

2026-10-22の利用者明示承認で、JST月上限を5→7 USDへ変更する。1 USD/run、30分、全工程最大985076 microUSDは維持。0011は予算triggerのみを置換し、旧run/call/予約/監査を更新しない。本変更の本番migration・配備は運用担当者の受入後で、以下の過去承認とは区別する。

2026-10-20追加: [新規調査・AI校閲](seo-research.md)は同じ台帳・上限を使い、検索contextと要求入力の各pass分・検索料を別の保守式で予約する。以下の本文生成の単価と通常CMSは変更しない。新機能は初期無効・実API未確認。

2026年10月19日に利用者がSEO分の上限を1実行1米ドル、月5米ドルと確定した。月は日本時間の暦月、API送信前の予約時点で計上する。既存CMSの対話利用とは独立したD1台帳で管理する。これはSEO生成APIの費用上限であり、CloudflareやGitHub等の利用料金を含めない。

`SeoConnection` は従来の接続専用契約を保持する。新しい `SeoGeneration` の名前付きService Bindingだけが改訂案を生成できる。HTTP入口は404、ユーザーのCMS権限やGitHub保存認証は流用しない。生成の許可は `SEO_GENERATION_ENABLED` で停止できる。GitHub dispatch・PR・統合・公開の機能はこのentrypointにない。

既存0004適用環境には `0011_seo_month_budget.sql` を新コード配備前に適用する。runとcallを別IDで記録し、同一callは再送しない。runは最初の受信から30分、対象記事は1つに固定する。SQL triggerでrun合計100万micro USD、月合計700万micro USDを超える予約を拒否する。同時実行もDBで制御し、エラー・不明結果・モデル返却の検証失敗で予約を戻さない。予約額は実請求額ではなく保守的な上限額。台帳は通常のコンテンツ保存期限で削除しない。

既存OpenAI Secrets Storeを内部で再利用し、`gpt-6-luna`、Standard (`service_tier=default`)、テキスト入力、最大出力12,000 tokensに固定する。モデル切替・画像・外部ツール・cache write・自動再試行を使わない。確定JSONのUTF-8 bytes + 8,192を入力tokensの保守的上限として、入力1米ドル/100万tokens、出力2米ドル/100万tokensで予約する。これは10月19日に確認した[公式Standard料金](https://developers.openai.com/api/docs/pricing)のlong-context入力0.20米ドル・出力0.75米ドルより高い保護単価である。2026年11月19日00:00 UTCからは料金再確認まで生成を停止する。変更後の料金や追加機能をこの見積りへ無条件に適用しない。

対象site、既存source path、変更許可path、入力上限を検証してから生成する。返却pathも許可リストと照合し、結果を非公開R2 `seo-proposals/<callId>.json` に上書きせず保存する。結果不明時は台帳と保存済みobjectを照合し、別call IDで盲目的に再試行しない。生成した案を実記事へ適用する前に、SEO側で最新main・source hash・観測ロック・open PR・一次資料・多言語契約・対象repoの検証を満たす必要がある。

合成試験では予算の同時競合、月境界、run期限、記事変更の拒否、送信前guard、失敗時の再送防止を確認する。クラウドの合成canaryは接続と課金台帳の検証であり、実記事の品質、翻訳、Draft PRまでの受け入れとは区別する。

## 推論設定の本番互換性

2026-10-19の合成接続検証で、Chat Completionsが `reasoning_effort=max` をHTTP 400 / unsupported_valueとして拒否した。SEO専用呼出しを `high` に固定し、生成後の自動再送・設定の自動切替は行わない。既存CMSの利用者選択とCodexの親・子設定は変更しない。失敗した2呼出しの予算予約は保持する。公開モデル資料と実応答の差があるため、本番受入は合成生成の成功で別途確認する。
