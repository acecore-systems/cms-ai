import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  recoverSources,
  recoveryDiscovery,
  recoveredReference,
} from "../src/seo-source-recovery.ts";
import type { Discovery } from "../src/seo-discovery.ts";
const old = "https://geysermc.org/wiki/geyser/setup/self/proxy-servers/";
const source = "---\ntitle: Source\n---\n\nGeyser port must not be shared.\n";
const current = "https://geysermc.org/wiki/geyser/setup/";
export const excerpt =
  "No other program can use the Geyser port, over either protocol. This includes programs that use UDP, such as voice chat mods or Query, and programs that use TCP, such as another server, a web map, or a website.";
function discovery(selectedUrl = old): Discovery {
  return {
    version: 5,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    planSha256: "b".repeat(64),
    responseId: "resp_fixture",
    responseSha256: "c".repeat(64),
    queries: ["Geyser official port"],
    urls: [selectedUrl],
    selectedUrl,
    fallbackUrl: null,
    externalScope: {
      siteId: "portal",
      sourceUrl: "https://asv.acecore.net/stories/test/",
      excludedHosts: ["asv.acecore.net"],
    },
  } as unknown as Discovery;
}
const html = (body = excerpt) =>
  new Response(body, { headers: { "content-type": "text/html" } });
it("recovers generic ordered 404 ancestors, not hardcoded Geyser targets, and binds provenance", async () => {
  for (const url of [
    old,
    "https://docs.astro.build/en/guides/obsolete/subpage/",
  ]) {
    const d = discovery(url);
    const parent = new URL("../../", url).href;
    const f = vi.fn(async (u, init) => {
      expect(init.redirect).toBe("manual");
      expect(init.headers).toEqual({ Accept: "text/html" });
      return String(u) === parent
        ? html()
        : new Response(null, { status: 404 });
    });
    const p = await recoverSources(
      d,
      source,
      Date.now() + 30000,
      f as typeof fetch,
    );
    expect(f).toHaveBeenCalledTimes(3);
    expect((await recoveryDiscovery(d, source, p)).selectedUrl).toBe(parent);
    expect(p.chains[0].visits.map((v) => v.status)).toEqual([404, 404, 200]);
    expect(p.chains[0].visits.at(-1)!.bodySha256).toMatch(/^[a-f0-9]{64}$/);
    const tampered = structuredClone(p);
    tampered.chains[0].visits[1].url = "https://evil.example.net/";
    await expect(recoveryDiscovery(d, source, tampered)).rejects.toThrow();
  }
});
it.each([
  "transport",
  "403",
  "500",
  "redirect",
  "cross-redirect",
  "oversized",
  "empty",
  "not-html",
])("does not recover unknown/unsafe HTTP %s", async (kind) => {
  const d = discovery();
  const f = vi.fn(async () => {
    if (kind === "transport") throw Error("offline");
    if (kind === "redirect" || kind === "cross-redirect")
      return new Response(null, {
        status: 302,
        headers: {
          Location: kind === "redirect" ? current : "http://169.254.169.254/",
        },
      });
    if (kind === "oversized") return html("x".repeat(262145));
    if (kind === "empty") return html("");
    if (kind === "not-html") return Response.json({ text: excerpt });
    return new Response(null, { status: Number(kind) });
  });
  const p = await recoverSources(
    d,
    source,
    Date.now() + 30000,
    f as typeof fetch,
  );
  expect(f).toHaveBeenCalledTimes(1);
  expect((await recoveryDiscovery(d, source, p)).selectedUrl).toBe(old);
});
it.each([
  "https://127.0.0.1/",
  "https://geysermc.org.evil.net/wiki/a/",
  "https://geysermc.org:8443/wiki/a/",
  "https://geysermc.org/wiki/%2e%2e/a/",
  "http://geysermc.org/wiki/a/",
  "https://user@geysermc.org/wiki/a/",
])("never fetches unsafe or unapproved URL %s", async (url) => {
  const f = vi.fn();
  const p = await recoverSources(discovery(url), source, Date.now() + 30000, f);
  expect(f).not.toHaveBeenCalled();
  expect(p.chains[0].selected).toBe(url);
});
it("bounds depth, deadline, deduplicates recovered URLs and does not skip a retrieved unrelated page", async () => {
  const f = vi.fn(async () => new Response(null, { status: 404 }));
  const d = discovery();
  await recoverSources(d, source, Date.now() + 30000, f);
  expect(f).toHaveBeenCalledTimes(4);
  f.mockClear();
  await recoverSources(d, source, Date.now() - 1, f);
  expect(f).not.toHaveBeenCalled();
  const unrelated = vi.fn(async () => html("unrelated navigation"));
  const p = await recoverSources(d, source, Date.now() + 30000, unrelated);
  expect(unrelated).toHaveBeenCalledTimes(1);
  expect(p.chains[0].selected).toBe(old);
  const two = {
    ...d,
    urls: [old, old.replace("self", "provider")],
    fallbackUrl: old.replace("self", "provider"),
  };
  const same = await recoverSources(
    two,
    source,
    Date.now() + 30000,
    async (u) =>
      String(u) === current ? html() : new Response(null, { status: 404 }),
  );
  const result = await recoveryDiscovery(two, source, same);
  expect(result.selectedUrl).toBe(current);
  expect(result.fallbackUrl).toBe(null);
});

it("permits an existing ancestor only through a complete bound 404 chain, never by a JSON flag", async () => {
  const withLink = source + "\n[Setup](" + current + ")\n";
  const d = {
    ...discovery(),
    sourceSha256: createHash("sha256").update(withLink).digest("hex"),
  };
  const proof = await recoverSources(
    d,
    withLink,
    Date.now() + 30000,
    async (u) =>
      String(u) === current ? html() : new Response(null, { status: 404 }),
  );
  const derived = await recoveryDiscovery(d, withLink, proof);
  expect(recoveredReference(derived, current)).toMatchObject({
    version: 2,
    url: current,
  });
  expect(
    recoveredReference(JSON.parse(JSON.stringify(derived)), current),
  ).toBeUndefined();
  expect(
    recoveredReference(derived, "https://geysermc.org/wiki/other/"),
  ).toBeUndefined();
  const direct = { ...d, selectedUrl: current, urls: [current] };
  const fetcher = vi.fn();
  const noProof = await recoverSources(
    direct,
    withLink,
    Date.now() + 30000,
    fetcher,
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    recoveredReference(
      await recoveryDiscovery(direct, withLink, noProof),
      current,
    ),
  ).toBeUndefined();
  const bad = structuredClone(proof);
  bad.chains[0].visits[0].status = 200;
  await expect(recoveryDiscovery(d, withLink, bad)).rejects.toThrow();
  await expect(recoveryDiscovery(d, source, proof)).rejects.toThrow();
});
it("aborts on the per-request timeout and performs no ancestor retry", async () => {
  vi.useFakeTimers();
  try {
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const f = vi.fn(
      async (_u, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(Error("deadline")),
          );
          ready();
        }),
    );
    const pending = recoverSources(
      discovery(),
      source,
      Date.now() + 30000,
      f as typeof fetch,
    );
    await started;
    await vi.advanceTimersByTimeAsync(3001);
    const proof = await pending;
    expect(f).toHaveBeenCalledTimes(1);
    expect(proof.chains[0].selected).toBe(old);
    expect(proof.chains[0].visits[0].status).toBe(null);
  } finally {
    vi.useRealTimers();
  }
});
