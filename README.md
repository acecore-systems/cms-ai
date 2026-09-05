# cms-ai

AcecoreのSveltia CMS採用サイトで共用する、会話型CMS AI基盤です。

## 方針

- モデルはCloudflare Workers AIの`@cf/zai-org/glm-5.3-flash`（Vision対応）を使います。
- 推論深度はメッセージごとに`low`、`medium`、`high`から選べます。
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

Workers AIの実推論はremote bindingが必要です。通常の単体テストではfixtureを使い、実モデル確認は本番反映前の明示的な検証で行います。

共有runnerはGitHub-hosted Linux runnerのDockerを利用します。依存関係の取得時だけsandboxのnetworkを有効にし、その後の検証コマンドはnetworkなしで実行します。

## 本番設定

初回画像対応の反映順序は、非公開R2 bucket `cms-ai-images`作成、D1 migration `0002_image_attachments.sql`適用、Worker deploy、各サイトの`client/`配布です。R2の公開URL・custom domain・CORSは有効にしません。schema変更は既存会話に空配列を追加する後方互換変更です。

次の値はrepositoryへ保存せず、Cloudflareのsecretとして設定します。

- `CMS_AI_GITHUB_APP_CLIENT_ID`
- `CMS_AI_GITHUB_APP_INSTALLATION_ID`
- `CMS_AI_GITHUB_APP_PRIVATE_KEY`
- `CMS_AI_ADMIN_ACCESS_AUD`

サイト別Access audienceは機密値ではありませんが、Access application作成後に`CMS_AI_SITE_AUDIENCES`へJSONで設定します。D1、custom domain、Access application、Pages Service Bindingは本番変更前に対象と影響を確認してから設定します。
