# サイト側integration

各Sveltia CMSサイトには次の薄いadapterだけを配置します。

- `public/admin/cms-ai-panel.js`と`cms-ai-panel.css`
- `/admin/api/ai/*`を中央Workerへ渡すPages Service Binding Function
- `workflow_dispatch`を受け、共有runner Actionを呼ぶworkflow

PagesのService Binding名は`CMS_AI`です。CMS本体のGitHub OAuthやサイト固有のCMS保存用GitHub Appとは共有しません。

本番では、サイトごとの`/admin/api/ai/*`をCloudflare Accessで保護します。CMS全体がすでにAccess配下にあるサイトは既存applicationのaudienceを使い、GitHub OAuthを使うCMSはAI APIだけにAccessを追加します。
