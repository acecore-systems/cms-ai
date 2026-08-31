export type SecretName =
  | "CMS_AI_ADMIN_ACCESS_AUD"
  | "CMS_AI_GITHUB_APP_CLIENT_ID"
  | "CMS_AI_GITHUB_APP_INSTALLATION_ID"
  | "CMS_AI_GITHUB_APP_PRIVATE_KEY";

export type AppEnv = Cloudflare.Env & Record<SecretName, string>;
