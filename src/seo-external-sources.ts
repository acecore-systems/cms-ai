import { markdown, type EditorialFile } from "./seo-content.ts";
import { researchInputs } from "./seo-research-plan.ts";
import { seoArticleUrl, seoSite } from "./sites.ts";

export type ExternalScope = { sourceUrl: string; excludedHosts: string[] };

// Only server-owned site configuration and canonical source metadata supply this scope.
export function externalScope(
  siteId: string,
  source: EditorialFile,
): ExternalScope {
  const spec = seoSite(siteId);
  if (!spec) throw new Error("seo_external_scope");
  const collection = Object.entries(spec.collections).find(
    ([, directory]) =>
      source.path.startsWith(directory + "/") &&
      !source.path.slice(directory.length + 1).includes("/"),
  );
  if (!collection || !source.path.endsWith(".md"))
    throw new Error("seo_external_scope");
  const slug = spec.slugField
    ? markdown(source.content).data[spec.slugField]
    : source.path.slice(collection[1].length + 1, -3);
  if (typeof slug !== "string") throw new Error("seo_external_scope");
  const sourceUrl = new URL(
    collection[0] + "/" + encodeURIComponent(slug) + "/",
    spec.site.canonicalUrl,
  ).href;
  if (!seoArticleUrl(siteId, sourceUrl)) throw new Error("seo_external_scope");
  return {
    sourceUrl,
    excludedHosts: [
      ...new Set([
        new URL(sourceUrl).hostname,
        ...spec.site.hostnames.filter((h) => !h.includes("*")),
      ]),
    ].sort(),
  };
}

function identity(value: string, scope: ExternalScope) {
  const url = new URL(value, scope.sourceUrl);
  // Fragments identify locations within an already cited document, not a new source.
  url.hash = "";
  return url.href;
}
export function externalExistingUrls(source: string, scope: ExternalScope) {
  return resolveExistingUrls(researchInputs(source).existingUrls, scope);
}
export function resolveExistingUrls(urls: string[], scope: ExternalScope) {
  return [
    ...new Set(
      urls.map((value) => {
        try {
          return identity(value, scope);
        } catch {
          return value;
        }
      }),
    ),
  ].sort();
}
export function isNewExternalUrl(
  value: string,
  source: string,
  scope: ExternalScope,
) {
  const url = new URL(value);
  return (
    !scope.excludedHosts.includes(url.hostname) &&
    !externalExistingUrls(source, scope).includes(identity(value, scope))
  );
}
