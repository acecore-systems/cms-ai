# cms-ai

AcecoreのSveltia CMS採用サイトで共用する、会話型CMS AI基盤です。

認証の境界と変更時の検証は [AGENTS.md](AGENTS.md) の方針を確認してください。

## 方針

- `CMS_AI_MODEL` は `@cf/deepseek-ai/deepseek-v4.1-flash-1017` です。既存のWorkers AI binding `AI`を使い、テキストと参考画像から会話回答・編集案を生成します。障害時のモデル自動切替やJSON Schemaを外した再送はしません。
- Chat Completionsの終了理由が`length`・`content_filter`等の未完了状態なら、有効なJSONが含まれていても変更案を受理しません。応答検証の失敗は`cms_ai_response_rejected`イベントへモデル・用途・固定値のphase/reasonだけを記録し、会話・ソース・画像・応答本文・推論過程を記録しません。
- 推論深度はメッセージごとに`low`、`medium`、`high`、`max`から選べます。DeepSeekでは`medium`を`high`へ対応させます。その他は同名の深度を渡します（[Cloudflare公式仕様](https://developers.cloudflare.com/workers-ai/models/deepseek-v4.1-flash-1017/)）。
- SEO生成・調査・校閲は別設定`SEO_AI_MODEL=gpt-6-luna`を使い、既存のOpenAI API直結とSecrets Store binding `OPENAI_API_KEY_STORE`を維持します。
- 質問、相談、修正依頼は同じ会話で扱い、対象URLの入力は求めません。
- 会話にPNG・JPEG・WebPを1回4枚、各2MiBまで添付・貼り付けできます。画像のみの送信も可能です。画像生成は行いません。
- 添付は非公開R2へ保存し、Access・サイト権限・会話所有者の検証後にだけ配信します。GitHub Actionsや公開リポジトリへ画像データを渡しません。
- 画像履歴は直近12ターン（文章24,000文字）の範囲内で、現在の添付を優先して合計16MiBまでモデルへ渡します。上限で省略された画像は再添付してください。画像は会話とともに保存され、自動削除はありません。
- 権限は`chat`、`editor`、`admin`の3段階です。
- AIはPRを作成しますが、自動マージしません。
- 各サイトのCMS保存認証と、CMS AIの認証・runner認証を分離します。

## 構成

- `src/`: Cloudflare Worker。Access JWT検証、D1会話・権限、Workers AI、GitHub workflow起動を担当します。
- `migrations/`: 共通D1のschemaです。
- `runner/`: 各サイトのGitHub Actionsから呼び出す共通Actionです。AI生成コードの依存関係インストール・テスト・ビルドは、GitHub/OIDC資格情報を渡さない一時Docker workspaceだけで実行します。
- `client/`: 各Sveltia CMSへvendorする会話UIです。
- `integration/`: Pages Functions用の薄いService Binding adapterとworkflow例です。

## ローカル確認

```powershell
npm ci
npm run types
npm run typecheck
npm test
npm run format:check
npm run deploy:dry-run
```

CMSの実モデル確認にはWorkers AIのremote bindingと有料アクセス、SEOにはOpenAI側の課金設定が必要です。通常の単体テストではfixtureを使います。文章・変更内容は生成APIが一度の推論で返し、権限・許可パス・PR承認はアプリケーションで検証します。

合成参考画像には`tests/fixtures/reference-red.png`（64×64の赤色RGB PNG）を使います。画像のCRC・終端・全画素は`tests/reference-image.test.ts`で検証します。実モデルの画像理解の確認結果と、JSON・編集内容の検証結果は区別します。

共有runnerはGitHub-hosted Linux runnerのDockerを利用します。依存関係の取得時だけsandboxのnetworkを有効にし、その後の検証コマンドはnetworkなしで実行します。

## 本番設定

初回画像対応の反映順序は、非公開R2 bucket `cms-ai-images`作成、D1 migration `0002_image_attachments.sql`適用、Worker deploy、各サイトの`client/`配布です。R2の公開URL・custom domain・CORSは有効にしません。schema変更は既存会話に空配列を追加する後方互換変更です。

次の値はrepositoryへ保存せず、Cloudflareのsecretとして設定します。

- `CMS_AI_GITHUB_APP_CLIENT_ID`
- `CMS_AI_GITHUB_APP_INSTALLATION_ID`
- `CMS_AI_GITHUB_APP_PRIVATE_KEY`
- `CMS_AI_ADMIN_ACCESS_AUD`

サイト別Access audienceは機密値ではありませんが、Access application作成後に`CMS_AI_SITE_AUDIENCES`へJSONで設定します。D1、custom domain、Access application、Pages Service Bindingは本番変更前に対象と影響を確認してから設定します。

## SEO定期処理との接続

SEO処理からは、Service Bindingで名前付きentrypoint `SeoConnection` の `readiness()` を呼ぶ。既存のAccess認証・CMSユーザー権限・GitHub AppをSEO Workerへ渡さない。このentrypointのHTTP fetchは404とする。

`SeoConnection`は6サイトの対応関係と候補3件・改訂1記事・Draft PRまでの契約を照合する接続のみで、従来どおり`generationEnabled=false`、`dispatchEnabled=false`を返す。このcapabilityではAI推論・D1変更・GitHub workflow起動は行わない。

承認済みの別capabilityとして、`SeoGeneration`は1回1 USD・月5 USDの永続予算で改訂案を作り、`SeoEditorial`は候補の順次検査・中央記事lock・改訂・翻訳・サイト検証・Draft PRを扱う。[クラウドSEOの導入・workflow・安全境界](docs/seo-editorial.md)を参照する。通常CMSとSEOのOIDC routeは分離し、自動startやSEOのCronはCMS側に設けない。接続成功、ローカル検証、実際のActions・生成・Draft PR成功を区別する。
