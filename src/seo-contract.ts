import { SITES } from "./sites.ts";

// This is a dedicated, read-only service contract. It grants no user/editor role.
// Generation stays disabled until a separately reviewed budget/execution adapter exists.
export function seoConnectionContract() {
  return {
    protocol: "acecore-seo-editorial-v1" as const,
    service: "cms-ai" as const,
    mode: "connection_only" as const,
    generationEnabled: false as const,
    dispatchEnabled: false as const,
    blockedBy: ["cost_budget_not_configured", "seo_execution_adapter_required"],
    limits: { candidates: 3, articles: 1, stopAt: "draft_pr" as const },
    sites: SITES.map((site) => ({
      id: site.id,
      repository: site.repository,
      branch: site.branch,
    })),
  };
}
