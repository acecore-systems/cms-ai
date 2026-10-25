import { generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../src/env.ts";
import {
  dispatchCmsAiJob,
  seoRepositoryReader,
  seoPublicationAbsent,
} from "../src/github.ts";
import type { Job } from "../src/models.ts";
import { getSiteById } from "../src/sites.ts";

describe("GitHub App authentication", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GitHubが配布するPKCS#1秘密鍵でworkflowを開始できる", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs1" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    const site = getSiteById("homepage-hatt");
    if (!site) throw new Error("Test site is missing.");

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const authorization = new Headers(init?.headers).get("Authorization");

        if (url.endsWith("/app/installations/123456/access_tokens")) {
          expect(authorization).toMatch(/^Bearer eyJ/);
          const payload = JSON.parse(
            Buffer.from(authorization!.split(".")[1], "base64url").toString(
              "utf8",
            ),
          );
          expect(payload.iss).toBe("Iv-test-client-id");
          expect(JSON.parse(String(init?.body))).toEqual({
            permissions: { actions: "write" },
            repositories: ["homepage-hatt"],
          });
          return Response.json(
            { token: "installation-token" },
            { status: 201 },
          );
        }

        if (
          url.endsWith(
            "/repos/acecore-systems/homepage-hatt/actions/workflows/.github%2Fworkflows%2Fcms-ai.yml/dispatches",
          )
        ) {
          expect(authorization).toBe("Bearer installation-token");
          expect(JSON.parse(String(init?.body))).toEqual({
            inputs: {
              conversation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              job_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            },
            ref: "main",
          });
          return new Response(null, { status: 204 });
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await dispatchCmsAiJob(
      {
        CMS_AI_GITHUB_APP_CLIENT_ID: "Iv-test-client-id",
        CMS_AI_GITHUB_APP_INSTALLATION_ID: "123456",
        CMS_AI_GITHUB_APP_PRIVATE_KEY: privateKey,
      } as AppEnv,
      site,
      testJob,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

const testJob: Job = {
  assistantMessage: null,
  branchName: "ai/cms-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  changedPaths: [],
  clarification: null,
  conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  createdAt: "2026-08-31T00:00:00.000Z",
  errorMessage: null,
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  instruction: "テスト",
  prUrl: null,
  reasoningEffort: "medium",
  requestedBy: "admin@example.com",
  requestedRole: "admin",
  siteId: "homepage-hatt",
  status: "queued",
  summary: null,
  turnNumber: 1,
  updatedAt: "2026-08-31T00:00:00.000Z",
};

describe("SEO authenticated public repository reader", () => {
  afterEach(() => vi.unstubAllGlobals());
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs1" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  const env = {
    CMS_AI_GITHUB_APP_CLIENT_ID: "test",
    CMS_AI_GITHUB_APP_INSTALLATION_ID: "123456",
    CMS_AI_GITHUB_APP_PRIVATE_KEY: privateKey,
  } as AppEnv;
  const site = getSiteById("homepage-hatt")!;
  const url =
    "https://api.github.com/repos/acecore-systems/homepage-hatt/commits/main";
  it("checks current refs and all-state PRs with read-only credentials, rejecting nonempty, unknown and paginated results", async () => {
    const job = "11111111-1111-4111-8111-111111111111";
    for (const kind of ["empty", "ref", "closed-pr", "unknown", "pages"]) {
      const requests: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const current = String(input);
          if (current.endsWith("/access_tokens")) {
            expect(JSON.parse(String(init?.body)).permissions).toEqual({
              contents: "read",
              pull_requests: "read",
            });
            return Response.json({
              token: "fixture",
              permissions: { contents: "read", pull_requests: "read" },
            });
          }
          requests.push(current);
          expect(init?.method).toBe("GET");
          const refs = current.includes("matching-refs");
          expect(
            refs
              ? current.endsWith("/git/matching-refs/heads/codex/seo-" + job)
              : new URL(current).searchParams.get("state") === "all",
          ).toBe(true);
          return Response.json(
            kind === "unknown"
              ? {}
              : (kind === "ref" && refs) || (kind === "closed-pr" && !refs)
                ? [{ state: "closed" }]
                : [],
            {
              headers: {
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "4900",
                ...(kind === "pages"
                  ? { link: '<https://api.github.com/next>; rel="next"' }
                  : {}),
              },
            },
          );
        }),
      );
      expect(
        await seoPublicationAbsent(env, site, job, Date.now() + 60000),
      ).toBe(kind === "empty");
      expect(requests.length).toBeLessThanOrEqual(2);
    }
  });
  function mock(status = 200, remaining = "4900", limit = "5000") {
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/access_tokens")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          permissions: { contents: "read", pull_requests: "read" },
          repositories: ["homepage-hatt"],
        });
        return Response.json({
          token: "fixture-token",
          permissions: {
            contents: "read",
            pull_requests: "read",
            metadata: "read",
          },
        });
      }
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer fixture-token",
      );
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      return new Response("{}", {
        status,
        headers: {
          "x-ratelimit-limit": limit,
          "x-ratelimit-remaining": remaining,
        },
      });
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  }
  it("uses one scoped token, fixed authenticated GETs and the 100-read bound", async () => {
    const fn = mock(),
      read = seoRepositoryReader(env, site, Date.now() + 60000);
    for (let i = 0; i < 100; i++) await read(url);
    await expect(read(url)).rejects.toThrow("seo_eligibility_unknown");
    expect(fn).toHaveBeenCalledTimes(101);
  });
  it("rejects every redirect without following the destination", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const fn = mock(status);
      await expect(
        seoRepositoryReader(env, site, Date.now() + 60000)(url),
      ).rejects.toMatchObject({ code: "read_unavailable" });
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn.mock.calls[1][1]?.redirect).toBe("manual");
    }
  });
  it("rejects other hosts/repos and write routes before credential creation", async () => {
    const fn = mock(),
      read = seoRepositoryReader(env, site, Date.now() + 60000);
    for (const target of [
      "https://evil.example/",
      url.replace("homepage-hatt", "other"),
      url.replace("commits/main", "actions/workflows/a/dispatches"),
    ])
      await expect(read(target)).rejects.toThrow("seo_eligibility_unknown");
    await expect(read(url, { method: "POST" })).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
  it("does not fall back to anonymous on auth, rate or missing evidence failure", async () => {
    for (const [status, remaining, limit] of [
      [403, "4900", "5000"],
      [429, "4900", "5000"],
      [200, "605", "5000"],
      [200, "", "5000"],
      [200, "59", "60"],
    ] as const) {
      const fn = mock(status, remaining, limit),
        read = seoRepositoryReader(env, site, Date.now() + 60000);
      await expect(read(url)).rejects.toThrow("seo_eligibility_unknown");
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });
  it("retains a denied token outcome without retry and never reads repository data", async () => {
    for (const status of [401, 403, 422, 500]) {
      const fn = vi.fn(async () =>
        Response.json(
          { message: "SENTINEL_PRIVATE", token: "SENTINEL_TOKEN" },
          { status },
        ),
      );
      vi.stubGlobal("fetch", fn);
      const read = seoRepositoryReader(env, site, Date.now() + 60000);
      const code =
        status === 401
          ? "token_authentication"
          : [403, 422].includes(status)
            ? "token_permission_denied"
            : "token_unavailable";
      await expect(read(url)).rejects.toMatchObject({
        message: "seo_eligibility_unknown",
        code,
      });
      await expect(read(url)).rejects.toMatchObject({
        message: "seo_eligibility_unknown",
        code,
      });
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });
  it("rejects missing, write, or unrelated token permissions", async () => {
    for (const permissions of [
      undefined,
      { contents: "write", pull_requests: "read" },
      { contents: "read", pull_requests: "read", actions: "write" },
      { contents: "read" },
    ]) {
      const fn = vi.fn(async () =>
        Response.json({ token: "SENTINEL_TOKEN", permissions }),
      );
      vi.stubGlobal("fetch", fn);
      await expect(
        seoRepositoryReader(env, site, Date.now() + 60000)(url),
      ).rejects.toMatchObject({
        message: "seo_eligibility_unknown",
        code: "token_scope_mismatch",
      });
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });
  it("distinguishes fixed read permission and rate diagnostics without response values", async () => {
    for (const [status, remaining, limit, code] of [
      [401, "4900", "5000", "read_authentication"],
      [403, "4900", "5000", "read_forbidden"],
      [429, "4900", "5000", "rate_insufficient"],
      [200, "", "5000", "rate_evidence_missing"],
      [200, "605", "5000", "rate_insufficient"],
      [500, "4900", "5000", "read_unavailable"],
    ] as const) {
      mock(status, remaining, limit);
      await expect(
        seoRepositoryReader(env, site, Date.now() + 60000)(url),
      ).rejects.toMatchObject({ message: "seo_eligibility_unknown", code });
    }
  });
});

describe("SEO completed workflow read", () => {
  afterEach(() => vi.unstubAllGlobals());
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs1" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  const env = {
    CMS_AI_GITHUB_APP_CLIENT_ID: "test",
    CMS_AI_GITHUB_APP_INSTALLATION_ID: "123456",
    CMS_AI_GITHUB_APP_PRIVATE_KEY: privateKey,
  } as AppEnv;
  const site = getSiteById("homepage-hatt")!;
  it.each([
    "success",
    "in_progress",
    "wrong_sha",
    "wrong_repo",
    "wrong_path",
    "wrong_id",
    "wrong_event",
    "wrong_branch",
    "failure",
    "unavailable",
    "scope",
  ])(
    "fails closed unless pinned workflow completed successfully: %s",
    async (kind) => {
      const { seoWorkflowCompleted } = await import("../src/github.ts");
      const fetcher = vi.fn(async (url: any, init: any) => {
        if (String(url).endsWith("/access_tokens")) {
          expect(JSON.parse(init.body)).toEqual({
            permissions: { actions: "read" },
            repositories: ["homepage-hatt"],
          });
          return Response.json({
            token: "fixture",
            permissions: {
              actions: kind === "scope" ? "write" : "read",
              metadata: "read",
            },
          });
        }
        expect(String(url)).toBe(
          "https://api.github.com/repos/acecore-systems/homepage-hatt/actions/runs/123",
        );
        expect(init.method).toBe("GET");
        expect(init.redirect).toBe("manual");
        expect(init.signal).toBeDefined();
        if (kind === "unavailable") return new Response(null, { status: 503 });
        return Response.json({
          id: kind === "wrong_id" ? 124 : 123,
          status: kind === "in_progress" ? "in_progress" : "completed",
          conclusion: kind === "failure" ? "failure" : "success",
          event: kind === "wrong_event" ? "push" : "workflow_dispatch",
          path:
            kind === "wrong_path"
              ? "other"
              : ".github/workflows/seo-content.yml",
          head_branch: kind === "wrong_branch" ? "other" : "main",
          head_sha: kind === "wrong_sha" ? "b".repeat(40) : "a".repeat(40),
          repository: {
            full_name: kind === "wrong_repo" ? "other" : site.repository,
          },
        });
      });
      vi.stubGlobal("fetch", fetcher);
      const promise = seoWorkflowCompleted(
        env,
        site,
        "123",
        "a".repeat(40),
        Date.now() + 15000,
      );
      if (kind === "scope") await expect(promise).rejects.toThrow();
      else expect(await promise).toBe(kind === "success");
      expect(fetcher).toHaveBeenCalledTimes(kind === "scope" ? 1 : 2);
    },
  );
});
