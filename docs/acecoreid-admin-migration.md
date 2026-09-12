# CMS AI管理画面のAcecoreID移行

`cms-ai.acecore.net/admin/` の人間のログインのみAcecoreIDに揃える。Access appの専用audienceと署名、AcecoreID subjectを検証し、既存のメールキーによるD1 site membership・chat/editor/admin・会話所有者・最後のadmin保護は変更しない。AcecoreIDにログインできても管理権限は付与しない。

全サイトを一度に切り替える必要はない。各サイト経由の会話APIは既存のsite audienceとD1 membershipを維持し、ログイン元のIdP制限は各サイトの移行時に行う。このPRは共通管理画面の切替であり、全サイト移行完了を意味しない。`/runner/` のGitHub Actions OIDCは機械認証なので変更しない。

## 切替条件

1. AcecoreID PR #56を反映し、Access IdPに `https://acecore.net/claims/subject` を追加する。app JWTのcustom内へ文字列として伝搬することを確認する。
2. 既存のCMS AI管理者全員の許可メールと検証済みAcecoreIDメールを照合する。D1 membershipのroleは変更しない。
3. 共通管理画面のAccess appをAcecoreIDだけにし、専用audience・既存policy条件を維持する。変更は当該appに限定する。
4. GitHub連携の本番deployと新規ログイン、site一覧・既存role別の許可/拒否を検証する。既存Accessセッションは再認証させる。

設定・利用者照合・本番確認が未完了の間はdraftを維持する。テストとdry-runは本番切替ではない。
