import { describe, expect, it } from "vitest";

import {
  getSiteAudiences,
  getSiteByHostname,
  getSiteById,
  isSiteSourcePath,
  isSiteWritablePath,
  normalizeRepositoryPath,
  SITES,
} from "../src/sites.ts";

describe("site policy", () => {
  it("6つのSveltia CMSサイトを一意に登録する", () => {
    expect(SITES).toHaveLength(6);
    expect(new Set(SITES.map((site) => site.id)).size).toBe(6);
    expect(new Set(SITES.map((site) => site.repository)).size).toBe(6);
  });

  it("custom domainとPages preview hostnameをサイトへ解決する", () => {
    expect(getSiteByHostname("hatt.acecore.net")?.id).toBe("homepage-hatt");
    expect(getSiteByHostname("abc123.homepage-hatt.pages.dev")?.id).toBe(
      "homepage-hatt",
    );
    expect(getSiteByHostname("unknown.example")).toBeNull();
  });

  it("Access audience overrideをサイト別に追加し不正値を捨てる", () => {
    const site = getSiteById("acecore-net")!;
    const audience = "a".repeat(64);
    expect(
      getSiteAudiences(
        site,
        JSON.stringify({
          "acecore-net": [audience, "not-an-audience"],
        }),
      ),
    ).toEqual([audience]);
  });

  it("サイト本文だけを書き込み対象にし認証・CMS管理・workflowを除外する", () => {
    const site = getSiteById("homepage-hatt")!;
    expect(isSiteWritablePath(site, "src/pages/index.astro")).toBe(true);
    expect(isSiteWritablePath(site, "src/content/blog/post.md")).toBe(true);
    expect(isSiteWritablePath(site, "public/admin/index.html")).toBe(false);
    expect(isSiteWritablePath(site, "src/pages/api/secret.ts")).toBe(false);
    expect(isSiteWritablePath(site, "src/pages/checkout.astro")).toBe(false);
    expect(isSiteWritablePath(site, "src/lib/stripe.ts")).toBe(false);
    expect(isSiteWritablePath(site, "src/middleware.ts")).toBe(false);
    expect(isSiteWritablePath(site, ".github/workflows/ci.yml")).toBe(false);
    expect(isSiteWritablePath(site, "package.json")).toBe(false);
    expect(isSiteSourcePath(site, "public/uploads/example.json")).toBe(false);
  });

  it("Wikiはsubproject外を読み書きしない", () => {
    const site = getSiteById("aceserver-wiki")!;
    expect(
      isSiteWritablePath(site, "poc/astro-sveltia/src/pages/index.astro"),
    ).toBe(true);
    expect(isSiteWritablePath(site, "src/pages/index.astro")).toBe(false);
    expect(
      isSiteWritablePath(site, "poc/astro-sveltia/public/admin/index.html"),
    ).toBe(false);
  });

  it("traversalと制御文字をrepository pathとして受け入れない", () => {
    expect(normalizeRepositoryPath("../secret.ts")).toBeNull();
    expect(normalizeRepositoryPath("src//index.ts")).toBeNull();
    expect(normalizeRepositoryPath("src/\u0000index.ts")).toBeNull();
  });
});
