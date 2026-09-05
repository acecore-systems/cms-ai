# Repository Guidelines

このリポジトリは複数サイトで共用するCMS AI基盤です。変更前にこのファイルを確認してください。

## 基本方針

- GitHub上のユーザー向け文章、PR、レビュー返信は明示がない限り日本語で書く。
- サイト固有値は`src/sites.ts`へ集約し、共通処理へhostname、repository、pathを直書きしない。
- Cloudflare Access、D1の利用権限、GitHub Actions OIDCを別の認証境界として扱う。
- `chat`権限からファイル変更を作成できないことをサーバー側で強制する。
- `editor`と`admin`でも自動マージせず、変更はbranchとPRへ限定する。
- CMS保存用GitHub AppやOAuth tokenをCMS AIへ流用しない。CMS AI Appはworkflow起動だけに使う。
- secret、Access JWT、メールallowlist、GitHub tokenをログへ出さない。
- 参考画像の入力を許可する。添付は非公開R2に保存し、サイト・会話所有者の認可を強制する。画像生成は追加しない。

## Cloudflare

- `wrangler.jsonc`を使い、binding変更後は`npm run types`で型を再生成する。
- D1はprepared statementと`bind()`を使う。
- Worker間通信はService Bindingを使い、利用可能なCloudflare bindingをREST経由で呼ばない。
- request固有の状態をmodule globalへ保存しない。
- Promiseは`await`、`return`、または`ctx.waitUntil()`で追跡する。
- structured logを使い、認証情報や個人情報を含めない。

## 検証

- `npm run types`
- `npm run typecheck`
- `npm test`
- `npm run format:check`
- `npm run deploy:dry-run`
- UI変更時はBrowser pluginでdesktopとmobile、console、主要interactionを確認する。
- commit前に`git diff --check`を実行する。

## PR

- 専用branch/worktreeを使い、PRはdraftで作成する。
- 実行した検証と未実施の本番確認をPR本文へ明記する。
