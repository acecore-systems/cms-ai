import { SeoRepositoryReadError } from "../src/github.ts";
import { it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { editorialEligibility } from "../src/seo-eligibility.ts";
import { seoArticleUrl } from "../src/sites.ts";
const url = "https://systems.acecore.net/insights/example/";
const site = "systems",
  base = "a".repeat(40),
  treeSha = "b".repeat(40),
  head = "c".repeat(40);
function fixture() {
  const target = seoArticleUrl(site, url)!;
  const path = target.directory + "/example.md";
  const content =
    '---\ntitle: Example\ndate: "2026-10-01T00:00:00Z"\n---\nText.';
  const bodies = new Map<string, string>();
  const entry = (path: string, body: string) => {
    const sha = createHash("sha1")
      .update(`blob ${Buffer.byteLength(body)}\0`)
      .update(body)
      .digest("hex");
    bodies.set(sha, body);
    return {
      path,
      sha,
      size: Buffer.byteLength(body),
      type: "blob",
      mode: "100644",
    };
  };
  const entries = [
    entry(path, content),
    ...target.spec.locales.map((l) =>
      entry(target.directory + "/" + l + "/example.md", content),
    ),
    entry(target.spec.statePath!, JSON.stringify({ sourceHash: "x" })),
  ];
  const pr = {
    number: 158,
    state: "open",
    head: { sha: head },
    base: { sha: base },
    updated_at: "2026-10-23T00:00:00Z",
    changed_files: 1,
  };
  let files: any[] = [{ filename: target.spec.statePath, status: "modified" }],
    truncated = false,
    open = true,
    mutate = false;
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, options?: RequestInit) => {
      expect(options?.headers).not.toHaveProperty("Authorization");
      expect(options?.redirect).toBe("error");
      const u = new URL(String(input)),
        p = u.pathname.replace("/repos/acecore-systems/acecore-systems", "");
      let value: any;
      if (p === "/commits/main")
        value = { sha: base, commit: { tree: { sha: treeSha } } };
      else if (p.startsWith("/git/trees/"))
        value = { sha: treeSha, truncated, tree: entries };
      else if (p === "/pulls") value = open ? [pr] : [];
      else if (p === "/pulls/158")
        value = { ...pr, head: { sha: mutate ? "d".repeat(40) : head } };
      else if (p === "/pulls/158/files") {
        const page = Number(u.searchParams.get("page"));
        const start = (page - 1) * 100;
        return new Response(JSON.stringify(files.slice(start, start + 100)), {
          headers:
            start + 100 < files.length
              ? { link: '<https://api.github.com/next>; rel="next"' }
              : {},
        });
      } else if (p.startsWith("/git/blobs/")) {
        const sha = p.split("/").at(-1)!,
          body = bodies.get(sha)!;
        value = {
          sha,
          size: Buffer.byteLength(body),
          encoding: "base64",
          content: Buffer.from(body).toString("base64"),
        };
      } else throw Error("unexpected fixture request " + p);
      return new Response(JSON.stringify(value));
    },
  ) as unknown as typeof fetch;
  return {
    target,
    entries,
    pr,
    fetcher,
    setFiles: (x: any[]) => {
      files = x;
      pr.changed_files = x.length;
    },
    setOpen: (x: boolean) => (open = x),
    setTruncated: () => (truncated = true),
    setMutate: () => (mutate = true),
  };
}
const input = () => ({ site, urls: [url], deadline: Date.now() + 60000 });
it("excludes actual shared state overlap, retaining all nine locale blob identities", async () => {
  const f = fixture(),
    r = await editorialEligibility(input(), f.fetcher);
  expect(r.results[0].status).toBe("conflict");
  expect(r.results[0].conflicts).toEqual([158]);
  expect(r.results[0].paths).toHaveLength(10);
  expect(r.proof.prs[0].paths).toEqual([f.target.spec.statePath]);
  expect(r.complete).toBe(true);
  expect(JSON.stringify(r)).not.toContain("Text.");
});
it("keeps unrelated articles eligible and includes rename previous paths", async () => {
  const f = fixture();
  f.setFiles([{ filename: "unrelated.md", status: "modified" }]);
  expect(
    (await editorialEligibility(input(), f.fetcher)).results[0].status,
  ).toBe("eligible");
  f.setFiles([
    {
      filename: "new-state.json",
      previous_filename: f.target.spec.statePath,
      status: "renamed",
    },
  ]);
  expect(
    (await editorialEligibility(input(), f.fetcher)).results[0].status,
  ).toBe("conflict");
});
it("checks translation paths, not just the canonical source", async () => {
  const f = fixture();
  f.setFiles([
    { filename: f.target.directory + "/ru/example.md", status: "modified" },
  ]);
  expect(
    (await editorialEligibility(input(), f.fetcher)).results[0].status,
  ).toBe("conflict");
});
it("missing source and missing locale are confirmed ineligible in a complete tree", async () => {
  const f = fixture();
  f.setOpen(false);
  f.entries.splice(1, 1);
  expect(
    (await editorialEligibility(input(), f.fetcher)).results[0].status,
  ).toBe("ineligible");
  f.entries.splice(0, 1);
  expect(
    (await editorialEligibility(input(), f.fetcher)).results[0].reason,
  ).toBe("canonical_source_missing_or_ambiguous");
});
it("does not interpret truncated tree or rate-limit as no PR", async () => {
  const f = fixture();
  f.setTruncated();
  await expect(editorialEligibility(input(), f.fetcher)).rejects.toThrow(
    "seo_eligibility_unknown",
  );
  await expect(
    editorialEligibility(
      input(),
      async () => new Response("", { status: 403 }),
    ),
  ).rejects.toThrow("seo_eligibility_unknown");
});
it("rejects PR head races and incomplete file counts", async () => {
  const f = fixture();
  f.setMutate();
  await expect(editorialEligibility(input(), f.fetcher)).rejects.toThrow(
    "seo_eligibility_unknown",
  );
  const g = fixture();
  g.pr.changed_files = 2;
  await expect(editorialEligibility(input(), g.fetcher)).rejects.toThrow(
    "seo_eligibility_unknown",
  );
});
it("rejects GitHub 3000-file truncation and malformed duplicate file rows", async () => {
  const f = fixture();
  f.pr.changed_files = 3001;
  await expect(editorialEligibility(input(), f.fetcher)).rejects.toThrow(
    "seo_eligibility_unknown",
  );
  const g = fixture();
  g.setFiles([
    { filename: "a", status: "modified" },
    { filename: "a", status: "modified" },
  ]);
  await expect(editorialEligibility(input(), g.fetcher)).rejects.toThrow(
    "seo_eligibility_unknown",
  );
});
it("rejects symlink source and tampered blob bytes", async () => {
  const f = fixture();
  f.entries[0].mode = "120000";
  expect(
    (await editorialEligibility(input(), f.fetcher)).results[0].status,
  ).toBe("ineligible");
  const g = fixture();
  g.setOpen(false);
  const fetcher: typeof fetch = async (u, o) => {
    const r = await g.fetcher(u, o);
    if (String(u).includes("/git/blobs/")) {
      const b: any = await r.json();
      b.content = Buffer.from("x".repeat(b.size)).toString("base64");
      return new Response(JSON.stringify(b));
    }
    return r;
  };
  await expect(editorialEligibility(input(), fetcher)).rejects.toThrow(
    "seo_eligibility_unknown",
  );
});
it("rejects invalid/duplicate URL inputs before HTTP requests", async () => {
  const f = fixture();
  for (const urls of [[url, url], ["https://evil.example/"], []])
    await expect(
      editorialEligibility({ ...input(), urls }, f.fetcher),
    ).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
});

it("proves complete multi-page files and rejects an endless/truncated listing", async () => {
  const f = fixture();
  f.setFiles([
    ...Array.from({ length: 100 }, (_, i) => ({
      filename: `unrelated-${i}.md`,
      status: "modified",
    })),
    { filename: f.target.spec.statePath, status: "modified" },
  ]);
  const r = await editorialEligibility(input(), f.fetcher);
  expect(r.proof.prs[0].pages).toBe(2);
  expect(r.proof.prs[0].changedFiles).toBe(101);
  expect(r.results[0].status).toBe("conflict");
  const wrapped: typeof fetch = async (u, o) => {
    if (String(u).includes("/pulls?"))
      return new Response(
        JSON.stringify(
          Array.from({ length: 100 }, (_, i) => ({ ...f.pr, number: i + 1 })),
        ),
        { headers: { link: '<https://api.github.com/next>; rel="next"' } },
      );
    return f.fetcher(u, o);
  };
  await expect(editorialEligibility(input(), wrapped)).rejects.toThrow(
    "seo_eligibility_unknown",
  );
});
it("rejects a newly opened PR at final read and source main movement", async () => {
  for (const endpoint of ["/pulls?", "/commits/main"]) {
    const f = fixture();
    let calls = 0;
    const wrapped: typeof fetch = async (u, o) => {
      const r = await f.fetcher(u, o);
      if (String(u).includes(endpoint) && ++calls === 2) {
        const v: any = await r.json();
        return new Response(
          JSON.stringify(
            endpoint === "/pulls?"
              ? [...v, { ...f.pr, number: 159 }]
              : { ...v, sha: "d".repeat(40) },
          ),
        );
      }
      return r;
    };
    await expect(editorialEligibility(input(), wrapped)).rejects.toThrow(
      "seo_eligibility_unknown",
    );
  }
});

it("does not fetch source or shared-state blobs for a proven path conflict", async () => {
  const f = fixture();
  await editorialEligibility(input(), f.fetcher);
  expect(
    (f.fetcher as any).mock.calls.some((c: any[]) =>
      String(c[0]).includes("/git/blobs/"),
    ),
  ).toBe(false);
});

it("logs only a fixed diagnostic code while preserving the RPC unknown contract", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const error of [
      new SeoRepositoryReadError("token_permission_denied"),
      new Error("SENTINEL_SECRET_RESPONSE"),
    ]) {
      const fetcher: typeof fetch = async () => {
        throw error;
      };
      await expect(editorialEligibility(input(), fetcher)).rejects.toThrow(
        "seo_eligibility_unknown",
      );
    }
    expect(warn.mock.calls).toEqual([
      [
        JSON.stringify({
          event: "seo_eligibility_unavailable",
          code: "token_permission_denied",
        }),
      ],
      [
        JSON.stringify({
          event: "seo_eligibility_unavailable",
          code: "unknown",
        }),
      ],
    ]);
  } finally {
    warn.mockRestore();
  }
});
