import { describe, expect, it } from "vitest";
import { seoConnectionContract } from "../src/seo-contract.ts";

describe("SEO service boundary", () => {
  it("advertises a disabled editorial connection for the six existing sites", () => {
    const contract = seoConnectionContract();
    expect(contract.protocol).toBe("acecore-seo-editorial-v1");
    expect(contract.generationEnabled).toBe(false);
    expect(contract.dispatchEnabled).toBe(false);
    expect(contract.limits).toEqual({
      candidates: 3,
      articles: 1,
      stopAt: "draft_pr",
    });
    expect(contract.blockedBy).toContain("cost_budget_not_configured");
    expect(contract.sites.map((site) => site.id).sort()).toEqual([
      "acecore-net",
      "acecore-systems",
      "aceserver-portal",
      "aceserver-wiki",
      "homepage-cherry",
      "homepage-hatt",
    ]);
  });

  it("returns fresh bounded metadata without user credentials or mutable policy", () => {
    const first = seoConnectionContract();
    first.sites.pop();
    first.blockedBy.length = 0;
    const second = seoConnectionContract();
    expect(second.sites).toHaveLength(6);
    expect(second.blockedBy).toHaveLength(2);
    expect(Object.keys(second).sort()).toEqual([
      "blockedBy",
      "dispatchEnabled",
      "generationEnabled",
      "limits",
      "mode",
      "protocol",
      "service",
      "sites",
    ]);
    expect(second.sites.every((site) => site.branch === "main")).toBe(true);
  });
});
