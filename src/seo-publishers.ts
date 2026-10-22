// Policy 2: publisher-owned documentation scopes verified 2026-10-22.
// Ranking only: publication ownership never proves a claim or its conditions.
export const PRIMARY_PUBLISHERS = [
  {
    host: "playwright.dev",
    path: "/docs/",
    evidence: "https://playwright.dev/docs/intro",
  },
  {
    host: "docs.astro.build",
    path: "/",
    evidence: "https://docs.astro.build/en/guides/internationalization/",
  },
  {
    host: "geysermc.org",
    path: "/wiki/",
    evidence: "https://geysermc.org/wiki/geyser/",
  },
  {
    host: "developers.google.com",
    path: "/search/docs/",
    evidence:
      "https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data",
  },
  {
    host: "developers.google.com",
    path: "/search/blog/",
    evidence:
      "https://developers.google.com/search/blog/2024/10/sitelinks-search-box",
  },
] as const;

export function preferredPublisher(raw: string): boolean {
  try {
    const url = new URL(raw);
    // Do not let parsing/normalization manufacture a publisher/path match.
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      url.href !== raw ||
      /[%\\\\]/.test(raw)
    )
      return false;
    return PRIMARY_PUBLISHERS.some(
      (p) => url.hostname === p.host && url.pathname.startsWith(p.path),
    );
  } catch {
    return false;
  }
}

export function selectedDiscoveryUrl(urls: string[], version: 1 | 2) {
  if (version === 1) return urls[0] || null;
  if (version !== 2) throw new Error("seo_check_evidence");
  return urls.find(preferredPublisher) || urls[0] || null;
}
