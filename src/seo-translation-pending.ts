import { sha256 } from "./seo-hash.ts";
import { normalizeLf, type EditorialFile } from "./seo-content.ts";
import type { seoSite } from "./sites.ts";

// Read-only preflight: inspect prior translation hashes only when a tracked
// revision marker exists. These bodies never enter generation/review context.
export async function hasPendingSeoRevision(
  spec: NonNullable<ReturnType<typeof seoSite>>,
  source: EditorialFile,
  manifest: string,
  read: (path: string) => Promise<string>,
): Promise<boolean> {
  const fail = (): never => {
    throw new Error("seo_pending_revision_invalid");
  };
  const value = JSON.parse(manifest);
  if (
    !value ||
    Object.keys(value).sort().join() !== "revisions,version" ||
    value.version !== 1 ||
    !value.revisions ||
    typeof value.revisions !== "object" ||
    Array.isArray(value.revisions)
  )
    return fail();
  const entry = value.revisions[source.path];
  if (entry === undefined) return false;
  if (
    !entry ||
    Object.keys(entry).sort().join() !==
      "previousSource,previousSourceHash,sourceHash,translations" ||
    typeof entry.previousSource !== "string" ||
    !/^[a-f0-9]{64}$/.test(entry.previousSourceHash) ||
    !/^[a-f0-9]{64}$/.test(entry.sourceHash) ||
    entry.previousSourceHash === entry.sourceHash ||
    (await sha256(normalizeLf(entry.previousSource))) !==
      entry.previousSourceHash ||
    !entry.translations ||
    Object.keys(entry.translations).sort().join() !==
      [...spec.locales].sort().join() ||
    Object.values(entry.translations).some(
      (hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash),
    )
  )
    return fail();
  for (const locale of spec.locales) {
    const path = source.path.replace(/\/([^/]+)$/, "/" + locale + "/$1");
    if (
      (await sha256(normalizeLf(await read(path)))) ===
      entry.translations[locale]
    ) {
      if ((await sha256(normalizeLf(source.content))) !== entry.sourceHash)
        return fail();
      return true;
    }
  }
  return false;
}
