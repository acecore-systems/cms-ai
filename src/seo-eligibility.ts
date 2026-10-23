import { SeoRepositoryReadError } from "./github.ts";
import { seoSite, seoArticleUrl, SEO_RESEARCH_EXCLUSIONS } from "./sites.ts";
import { sourceIdentity, markdown, normalizeLf } from "./seo-content.ts";
import { sha256 } from "./seo-hash.ts";

const fail = (): never => {
  throw new Error("seo_eligibility_unknown");
};
const validSha = (s: unknown): s is string =>
  typeof s === "string" && /^[a-f0-9]{40}$/.test(s);
const validPath = (s: unknown): s is string =>
  typeof s === "string" &&
  s.length <= 1024 &&
  !/[\\\u0000-\u001f]/.test(s) &&
  !s.startsWith("/") &&
  !s.split("/").some((x) => x === "." || x === ".." || !x);

// Public repository reads through the injected authenticated reader. No App
// token, credential, source text or PR body is returned or persisted. Every bound failure is unknown, never no conflicts.
export async function editorialEligibility(
  input: unknown,
  fetcher: typeof fetch,
) {
  let stage = "input";
  try {
    return await inspectEligibility(input, fetcher, (value) => {
      stage = value;
    });
  } catch (error) {
    // Fixed local enum only. RPC still returns the same unknown error contract.
    console.warn(
      JSON.stringify({
        event: "seo_eligibility_unavailable",
        stage,
        code: error instanceof SeoRepositoryReadError ? error.code : "unknown",
      }),
    );
    return fail();
  }
}
async function inspectEligibility(
  input: unknown,
  fetcher: typeof fetch,
  mark: (stage: string) => void,
) {
  const v = input as { site: string; urls: string[]; deadline: number };
  const spec = v && seoSite(v.site);
  if (
    !spec ||
    !Array.isArray(v.urls) ||
    v.urls.length > 500 ||
    !v.urls.length ||
    new Set(v.urls).size !== v.urls.length ||
    !Number.isSafeInteger(v.deadline) ||
    v.deadline <= Date.now() ||
    v.deadline > Date.now() + 30 * 60_000 ||
    v.urls.some((url) => typeof url !== "string" || !seoArticleUrl(v.site, url))
  )
    return fail();
  const repository = spec.site.repository,
    prefix = `/repos/${repository}`;
  let requests = 0;
  async function get(path: string) {
    if (++requests > 100 || Date.now() >= v.deadline) return fail();
    mark("fetch");
    const response = await fetcher("https://api.github.com" + prefix + path, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "acecore-seo-eligibility",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(Math.min(10000, v.deadline - Date.now())),
    });
    mark("response");
    if (!response.ok) return fail();
    // Tree API is capped at 7MB. Also bound responses when Content-Length is absent.
    const reader = response.body?.getReader();
    if (!reader) return fail();
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        return fail();
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    mark("json_decode");
    return {
      value: JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      ),
      link: response.headers.get("link"),
    };
  }
  async function pages(path: string, max: number) {
    const rows: any[] = [];
    let count = 0;
    for (let page = 1; page <= max; page++) {
      const r = await get(
        path + (path.includes("?") ? "&" : "?") + `per_page=100&page=${page}`,
      );
      if (!Array.isArray(r.value) || r.value.length > 100) return fail();
      rows.push(...r.value);
      count++;
      const next = r.link?.includes('rel="next"');
      if (!next) return { rows, pages: count };
      if (r.value.length !== 100) return fail();
    }
    return fail();
  }
  const main = await get("/commits/main");
  mark("main_shape");
  const baseSha = main.value.sha,
    treeSha = main.value.commit?.tree?.sha;
  if (!validSha(baseSha) || !validSha(treeSha)) return fail();
  const tree = await get(`/git/trees/${treeSha}?recursive=1`);
  mark("tree_shape");
  if (
    tree.value.truncated !== false ||
    tree.value.sha !== treeSha ||
    !Array.isArray(tree.value.tree)
  )
    return fail();
  mark("tree_entries");
  const entries = new Map<string, any>();
  for (const item of tree.value.tree) {
    if (!validPath(item.path) || entries.has(item.path) || !validSha(item.sha))
      return fail();
    entries.set(item.path, item);
  }
  const blobCache = new Map<string, string>();
  async function read(path: string) {
    const e = entries.get(path);
    if (
      !e ||
      e.type !== "blob" ||
      !["100644", "100755"].includes(e.mode) ||
      !Number.isSafeInteger(e.size) ||
      e.size > 448 * 1024
    )
      return fail();
    if (blobCache.has(e.sha)) return blobCache.get(e.sha)!;
    const r = (await get(`/git/blobs/${e.sha}`)).value;
    if (
      r.sha !== e.sha ||
      r.encoding !== "base64" ||
      typeof r.content !== "string" ||
      r.size !== e.size
    )
      return fail();
    mark("blob_decode");
    const bytes = Uint8Array.from(atob(r.content.replace(/\n/g, "")), (c) =>
      c.charCodeAt(0),
    );
    if (bytes.length !== e.size) return fail();
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`),
      whole = new Uint8Array(header.length + bytes.length);
    whole.set(header);
    whole.set(bytes, header.length);
    mark("blob_digest");
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-1", whole)),
    )
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    if (digest !== e.sha) return fail();
    mark("blob_utf8");
    const content = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
    blobCache.set(e.sha, content);
    return content;
  }
  const open = await pages("/pulls?state=open&sort=created&direction=asc", 10);
  const signature = (rows: any[]) =>
    JSON.stringify(
      rows.map((p) => {
        if (
          !Number.isSafeInteger(p.number) ||
          p.number < 1 ||
          p.state !== "open" ||
          !validSha(p.head?.sha) ||
          !validSha(p.base?.sha) ||
          typeof p.updated_at !== "string"
        )
          return fail();
        return [p.number, p.head.sha, p.base.sha, p.updated_at];
      }),
    );
  mark("pr_signature");
  const initial = signature(open.rows);
  if (new Set(open.rows.map((p) => p.number)).size !== open.rows.length)
    return fail();
  const prs: {
    number: number;
    headSha: string;
    baseSha: string;
    changedFiles: number;
    pages: number;
    paths: string[];
  }[] = [];
  for (const pr of open.rows) {
    const detail = (await get(`/pulls/${pr.number}`)).value;
    if (
      signature([detail]) !== signature([pr]) ||
      !Number.isSafeInteger(detail.changed_files) ||
      detail.changed_files < 0 ||
      detail.changed_files > 3000
    )
      return fail();
    const listing = await pages(`/pulls/${pr.number}/files`, 30);
    if (listing.rows.length !== detail.changed_files) return fail();
    const paths = new Set<string>(),
      names = new Set<string>();
    for (const file of listing.rows) {
      if (!validPath(file.filename) || names.has(file.filename)) return fail();
      names.add(file.filename);
      paths.add(file.filename);
      if (file.status === "renamed") {
        if (!validPath(file.previous_filename)) return fail();
        paths.add(file.previous_filename);
      }
    }
    const after = (await get(`/pulls/${pr.number}`)).value;
    if (
      signature([after]) !== signature([detail]) ||
      after.changed_files !== detail.changed_files
    )
      return fail();
    prs.push({
      number: pr.number,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      changedFiles: detail.changed_files,
      pages: listing.pages,
      paths: [...paths].sort(),
    });
  }
  const results = [];
  for (const url of v.urls) {
    mark("candidate");
    const target = seoArticleUrl(v.site, url)!;
    const roots = [...entries.keys()].filter(
      (path) =>
        path.startsWith(target.directory + "/") &&
        !path.slice(target.directory.length + 1).includes("/") &&
        path.endsWith(".md"),
    );
    const possible = target.spec.slugField
      ? roots
      : roots.filter(
          (path) => path === target.directory + "/" + target.slug + ".md",
        );
    const files = [];
    for (const path of possible)
      files.push({
        path,
        content: target.spec.slugField ? await read(path) : "",
      });
    const matches = files.filter((f) =>
      target.spec.slugField
        ? markdown(f.content).data[target.spec.slugField] === target.slug
        : true,
    );
    if (matches.length !== 1) {
      results.push({
        url,
        status: "ineligible" as const,
        reason: "canonical_source_missing_or_ambiguous",
      });
      continue;
    }
    if (SEO_RESEARCH_EXCLUSIONS[spec.key]?.includes(matches[0].path)) {
      results.push({
        url,
        status: "ineligible" as const,
        reason: "owned_policy_not_external_research",
      });
      continue;
    }
    const filename = matches[0].path.slice(target.directory.length + 1);
    const localePaths = target.spec.locales.map(
      (locale) => `${target.directory}/${locale}/${filename}`,
    );
    const paths = [
      matches[0].path,
      ...localePaths,
      ...(spec.statePath ? [spec.statePath] : []),
    ];
    if (
      paths.some((path) => {
        const e = entries.get(path);
        return (
          !e || e.type !== "blob" || !["100644", "100755"].includes(e.mode)
        );
      })
    ) {
      results.push({
        url,
        status: "ineligible" as const,
        reason: "required_path_missing",
      });
      continue;
    }
    const conflicts = prs
      .filter((pr) => pr.paths.some((path) => paths.includes(path)))
      .map((pr) => pr.number);
    if (conflicts.length) {
      results.push({
        url,
        status: "conflict" as const,
        articleKey: `${v.site}:${matches[0].path}`,
        paths: paths.map((path) => ({ path, blobSha: entries.get(path).sha })),
        conflicts,
      });
      continue;
    }
    if (!target.spec.slugField)
      matches[0].content = await read(matches[0].path);
    // sourceIdentity reads the real canonical body and checks every locale's path.
    // Translation bodies are not needed to establish a file-overlap intersection.
    const identity = sourceIdentity(v.site, url, [
      matches[0],
      ...localePaths.map((path) => ({ path, content: "" })),
    ]);
    if (!identity) {
      results.push({
        url,
        status: "ineligible" as const,
        reason: "source_identity_ineligible",
      });
      continue;
    }
    if (
      spec.statePath &&
      JSON.parse(await read(spec.statePath)).pendingInsights?.[target.slug]
    ) {
      results.push({
        url,
        status: "ineligible" as const,
        reason: "translation_pending",
      });
      continue;
    }
    results.push({
      url,
      status: conflicts.length ? ("conflict" as const) : ("eligible" as const),
      articleKey: identity.articleKey,
      sourceSha256: await sha256(normalizeLf(identity.source.content)),
      paths: paths.map((path) => ({ path, blobSha: entries.get(path).sha })),
      conflicts,
    });
  }
  const finalOpen = await pages(
    "/pulls?state=open&sort=created&direction=asc",
    10,
  );
  if (
    signature(finalOpen.rows) !== initial ||
    (await get("/commits/main")).value.sha !== baseSha
  )
    return fail();
  return {
    version: 1 as const,
    site: v.site,
    repository,
    baseSha,
    treeSha,
    checkedAt: Date.now(),
    complete: true as const,
    proof: {
      treeTruncated: false,
      openPrPages: open.pages,
      finalOpenPrPages: finalOpen.pages,
      requests,
      prs,
    },
    results,
  };
}
