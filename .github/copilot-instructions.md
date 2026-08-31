変更前に`AGENTS.md`を確認してください。CMS AIではAccess認証、D1 RBAC、GitHub Actions OIDCを分離し、`chat`権限の変更生成禁止、自動マージ無効、画像機能なしを維持します。サイト固有値は`src/sites.ts`へ集約し、Cloudflare bindingの型は`wrangler types`で生成します。
