# サイト側integration

各Sveltia CMSサイトには次の薄いadapterだけを配置します。

- `public/admin/ai-panel.js`と`ai-panel.css`
- `/admin/api/ai/*`を中央Workerへ渡すPages Service Binding Function
- `workflow_dispatch`を受け、共有runner Actionを呼ぶworkflow

PagesのService Binding名は`CMS_AI`です。CMS本体のGitHub OAuthやサイト固有のCMS保存用GitHub Appとは共有しません。

workflowは`actions/checkout`の資格情報をworktreeへ永続化しません。共有runnerは必要なGit操作だけに`GITHUB_TOKEN`を渡し、AI生成コードの検証は資格情報のない一時Docker workspaceへ隔離します。

本番では、サイトごとの`/admin/api/ai/*`をCloudflare Accessで保護します。CMS全体がすでにAccess配下にあるサイトは既存applicationのaudienceを使い、GitHub OAuthを使うCMSはAI APIだけにAccessを追加します。
