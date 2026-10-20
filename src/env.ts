export type SecretName =
  | "CMS_AI_ADMIN_ACCESS_AUD"
  | "CMS_AI_GITHUB_APP_CLIENT_ID"
  | "CMS_AI_GITHUB_APP_INSTALLATION_ID"
  | "CMS_AI_GITHUB_APP_PRIVATE_KEY";

export type SeoCoordinatorBinding = {
  claim(input: {
    runId: string;
    articleKey: string;
    sourceSha256: string;
  }): Promise<{ status: "claimed" | "denied" }>;
  complete(input: {
    runId: string;
    articleKey: string;
    status: "draft_pr" | "unresolved";
    prUrl?: string;
  }): Promise<{ status: "recorded" | "denied" }>;
};
export type AppEnv = Omit<Cloudflare.Env, "SEO_COORDINATOR"> &
  Record<SecretName, string> & {
    OPENAI_API_KEY_STORE?: { get(): Promise<string> };
    SEO_RESEARCH_ENABLED?: string;
    SEO_RESEARCH_CANARY_RUN_ID?: string;
    SEO_COORDINATOR?: SeoCoordinatorBinding;
  };
