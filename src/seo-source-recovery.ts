import type { AppEnv } from "./env.ts";
import type { Discovery } from "./seo-discovery.ts";
import { isNewExternalUrl } from "./seo-external-sources.ts";
import { preferredPublisher } from "./seo-publishers.ts";
import { sha256 } from "./seo-hash.ts";

// Public, already allowlisted publisher origins only. Never fetch arbitrary
// referenceUrl destinations: that function is not an SSRF boundary.
export const SOURCE_RECOVERY_LIMITS = Object.freeze({
  requests: 8,
  parents: 3,
  bytes: 262144,
  totalBytes: 1048576,
  ms: 10000,
  requestMs: 3000,
});
type Visit = {
  url: string;
  status: number | null;
  bytes: number;
  bodySha256: string | null;
};
export type SourceRecovery = {
  version: 2;
  discoverySha256: string;
  checkedAt: number;
  chains: { original: string; visits: Visit[]; selected: string }[];
};
const originals = (d: Discovery) =>
  [d.selectedUrl, d.fallbackUrl].filter(
    (x): x is string => typeof x === "string",
  );
function parent(raw: string) {
  const u = new URL(raw);
  u.pathname = u.pathname.replace(/\/?[^/]+\/?$/, "/");
  return u.href !== raw && preferredPublisher(u.href) ? u.href : null;
}
function eligible(raw: string, d: Discovery, source: string) {
  return (
    preferredPublisher(raw) &&
    !!d.externalScope &&
    !d.externalScope.excludedHosts.includes(new URL(raw).hostname)
  );
}
export async function recoverSources(
  d: Discovery,
  source: string,
  deadline: number,
  fetcher: typeof fetch = fetch,
): Promise<SourceRecovery> {
  if (d.version !== 5) throw new Error("seo_check_evidence");
  const proof: SourceRecovery = {
    version: 2,
    discoverySha256: await sha256(JSON.stringify(d)),
    checkedAt: Date.now(),
    chains: [],
  };
  const end = Math.min(deadline, Date.now() + SOURCE_RECOVERY_LIMITS.ms);
  let count = 0,
    total = 0;
  for (const original of originals(d)) {
    const chain: SourceRecovery["chains"][number] = {
      original,
      visits: [],
      selected: original,
    };
    proof.chains.push(chain);
    let url: string | null =
      d.externalScope &&
      isNewExternalUrl(
        original,
        source,
        d.externalScope,
        d.referencePolicy ?? 1,
      )
        ? original
        : null;
    for (
      let depth = 0;
      url && depth <= SOURCE_RECOVERY_LIMITS.parents;
      depth++
    ) {
      if (
        !eligible(url, d, source) ||
        Date.now() >= end ||
        count >= SOURCE_RECOVERY_LIMITS.requests ||
        total >= SOURCE_RECOVERY_LIMITS.totalBytes
      )
        break;
      count++;
      const visit: Visit = { url, status: null, bytes: 0, bodySha256: null };
      chain.visits.push(visit);
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.max(
          1,
          Math.min(end - Date.now(), SOURCE_RECOVERY_LIMITS.requestMs),
        ),
      );
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await fetcher(url, {
          method: "GET",
          redirect: "manual",
          headers: { Accept: "text/html" },
          signal: controller.signal,
        });
        // Redirects (including same-origin), errors, missing/oversized bodies and
        // unknown transport outcomes never establish a recovery chain.
        if ([404, 410].includes(response.status)) {
          await response.body?.cancel();
          visit.status = response.status;
          url = parent(url);
          continue;
        }
        if (
          response.status !== 200 ||
          response.redirected ||
          !/^text\/html(?:;|$)/i.test(
            response.headers.get("content-type") || "",
          ) ||
          Number(response.headers.get("content-length") || 0) >
            SOURCE_RECOVERY_LIMITS.bytes ||
          !response.body
        ) {
          await response.body?.cancel();
          break;
        }
        reader = response.body.getReader();
        const parts: Uint8Array[] = [];
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          total += part.value.byteLength;
          visit.bytes += part.value.byteLength;
          if (
            visit.bytes > SOURCE_RECOVERY_LIMITS.bytes ||
            total > SOURCE_RECOVERY_LIMITS.totalBytes ||
            Date.now() >= end
          )
            throw new Error("bound");
          parts.push(part.value);
        }
        if (!visit.bytes || Date.now() >= end || controller.signal.aborted)
          break;
        const body = new Uint8Array(visit.bytes);
        let offset = 0;
        for (const part of parts) {
          body.set(part, offset);
          offset += part.byteLength;
        }
        visit.bodySha256 = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", body)),
          (x) => x.toString(16).padStart(2, "0"),
        ).join("");
        visit.status = 200;
        chain.selected = url;
        break;
      } catch {
        break;
      } finally {
        clearTimeout(timer);
        await reader?.cancel().catch(() => {});
      }
    }
  }
  return proof;
}

// Replay checks every hop; existence/body hash is only candidate provenance,
// never claim support. Actual hosted open + citation + full claim still required.
export async function recoveryDiscovery(
  d: Discovery,
  source: string,
  p: SourceRecovery,
): Promise<Discovery> {
  if (
    d.sourceSha256 !== (await sha256(source.replace(/\r\n/g, "\n"))) ||
    p.version !== 2 ||
    p.discoverySha256 !== (await sha256(JSON.stringify(d))) ||
    !Number.isSafeInteger(p.checkedAt) ||
    !Array.isArray(p.chains) ||
    p.chains.length !== originals(d).length
  )
    throw new Error("seo_check_evidence");
  let count = 0,
    bytes = 0;
  const urls = p.chains.map((c, i) => {
    if (
      c.original !== originals(d)[i] ||
      !Array.isArray(c.visits) ||
      c.visits.length > 4
    )
      throw new Error("seo_check_evidence");
    if (
      c.visits.length &&
      (!d.externalScope ||
        !isNewExternalUrl(
          c.original,
          source,
          d.externalScope,
          d.referencePolicy ?? 1,
        ))
    )
      throw new Error("seo_check_evidence");
    let expected: string | null = c.original;
    for (const [j, v] of c.visits.entries()) {
      count++;
      bytes += v.bytes;
      if (
        v.url !== expected ||
        !eligible(v.url, d, source) ||
        !Number.isSafeInteger(v.bytes) ||
        v.bytes < 0 ||
        ![null, 200, 404, 410].includes(v.status)
      )
        throw new Error("seo_check_evidence");
      if ([404, 410].includes(v.status!)) {
        if (v.bytes !== 0 || v.bodySha256 !== null)
          throw new Error("seo_check_evidence");
        expected = parent(v.url);
      } else {
        if (
          j !== c.visits.length - 1 ||
          (v.status === 200 &&
            (!v.bytes ||
              v.bytes > SOURCE_RECOVERY_LIMITS.bytes ||
              !/^[a-f0-9]{64}$/.test(v.bodySha256 || "")))
        )
          throw new Error("seo_check_evidence");
      }
    }
    if (
      c.selected !== c.original &&
      (!c.visits.length ||
        c.visits.at(-1)!.url !== c.selected ||
        c.visits.at(-1)!.status !== 200 ||
        c.visits.slice(0, -1).some((v) => ![404, 410].includes(v.status!)))
    )
      throw new Error("seo_check_evidence");
    return c.selected;
  });
  // A final chunk may exceed a byte cap; only failed chains may contain it.
  if (
    count > 8 ||
    bytes > SOURCE_RECOVERY_LIMITS.totalBytes + SOURCE_RECOVERY_LIMITS.bytes
  )
    throw new Error("seo_check_evidence");
  const unique = [...new Set(urls)];
  const existing = p.chains
    .filter(
      (c) =>
        c.selected !== c.original &&
        !isNewExternalUrl(
          c.selected,
          source,
          d.externalScope!,
          d.referencePolicy ?? 1,
        ),
    )
    .map((c) => c.selected);
  return Object.assign(
    new ProvenRecovery(existing, await sha256(JSON.stringify(p))),
    d,
    {
      urls: [...new Set([...d.urls, ...unique])],
      selectedUrl: unique[0],
      fallbackUrl: unique[1] || null,
    },
  );
}
// Runtime brand cannot be supplied by a runner JSON payload. It is created only
// after chain validation above; durable reads additionally verify the D1 hash.
class ProvenRecovery {
  constructor(
    private readonly existing: readonly string[],
    private readonly proofSha256: string,
  ) {}
  reference(url: string) {
    return this.existing.includes(url)
      ? { version: 2 as const, url, proofSha256: this.proofSha256 }
      : undefined;
  }
}
export function recoveredReference(d: Discovery | undefined, url: string) {
  return d instanceof ProvenRecovery ? d.reference(url) : undefined;
}
const proofKey = (job: string) => `seo-editorial/${job}/source-recovery.json`;
export async function saveSourceRecovery(
  env: AppEnv,
  job: string,
  proof: SourceRecovery,
) {
  const raw = JSON.stringify(proof);
  if (
    !(await env.CMS_AI_IMAGES.put(proofKey(job), raw, {
      onlyIf: { etagDoesNotMatch: "*" },
    }))
  )
    throw new Error("seo_check_conflict");
  await env.CMS_AI_DB.prepare(
    "INSERT INTO seo_source_recovery_results(job_id,proof_sha256) VALUES(?,?)",
  )
    .bind(job, await sha256(raw))
    .run();
}
export async function loadSourceRecovery(
  env: AppEnv,
  job: string,
): Promise<SourceRecovery> {
  const row = await env.CMS_AI_DB.prepare(
    "SELECT proof_sha256 FROM seo_source_recovery_results WHERE job_id=?",
  )
    .bind(job)
    .first<{ proof_sha256: string }>();
  const obj = await env.CMS_AI_IMAGES.get(proofKey(job));
  const raw = obj && (await obj.text());
  if (!row || !raw || (await sha256(raw)) !== row.proof_sha256)
    throw new Error("seo_check_evidence");
  return JSON.parse(raw);
}
