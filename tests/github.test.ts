import { generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../src/env.ts";
import { dispatchCmsAiJob } from "../src/github.ts";
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
