import { expect, it } from "vitest";
import {
  preferredPublisher,
  selectedDiscoveryUrl,
} from "../src/seo-publishers.ts";

it.each([
  "https://playwright.dev/docs/intro",
  "https://docs.astro.build/en/guides/internationalization/",
  "https://geysermc.org/wiki/geyser/",
  "https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data",
  "https://developers.google.com/search/blog/2014/09/improved-sitelinks-search-box",
])("prefers verified publisher scope: %s", (url) =>
  expect(preferredPublisher(url)).toBe(true),
);

it.each([
  "https://playwright.dev.evil.example/docs/intro",
  "https://user.playwright.dev/docs/intro",
  "https://playwright.dev/docs-user/intro",
  "https://playwright.dev/community/post",
  "https://support.google.com/webmasters/thread/123",
  "https://github.com/google/discussions/123",
  "https://geysermc.org/wiki-user/geyser/",
  "https://developers.google.com/search/blogger/user",
  "https://evil.example@playwright.dev/docs/intro",
  "https://playwright.dev/docs/%2e%2e/community",
  "https://playwright.dev/other/../docs/intro",
  "https://playwright.dev/docs/intro?redirect=user",
])("does not promote posts, spoofed hosts or normalized paths: %s", (url) =>
  expect(preferredPublisher(url)).toBe(false),
);

it("keeps v1 order, uses stable v2 preference and does not rewrite or discard fallback URLs", () => {
  const urls = [
    "https://www.linkedin.com/posts/example",
    "https://developers.google.com/search/blog/2014/09/improved-sitelinks-search-box",
    "https://playwright.dev/docs/intro",
  ];
  const before = [...urls];
  expect(selectedDiscoveryUrl(urls, 1)).toBe(urls[0]);
  expect(selectedDiscoveryUrl(urls, 2)).toBe(urls[1]);
  expect(selectedDiscoveryUrl(urls.slice(0, 1), 2)).toBe(urls[0]);
  expect(selectedDiscoveryUrl([], 2)).toBeNull();
  expect(urls).toEqual(before);
});
