import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { authenticateRunner } from "../src/oidc.ts";
import { SEO_RUNNER_AUDIENCE } from "../src/sites.ts";
import type { AppEnv } from "../src/env.ts";
const issuer = "https://seo-oidc.test";
let key: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  key = pair.privateKey;
  const jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "seo-key",
    alg: "RS256",
    use: "sig",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ keys: [jwk] })),
  );
});
const env = {
  CMS_AI_GITHUB_OIDC_ISSUER: issuer,
  CMS_AI_RUNNER_AUDIENCE: "https://cms-ai.acecore.net/runner",
} as AppEnv;
const claims = {
  repository: "acecore-systems/aceserver-portal",
  ref: "refs/heads/main",
  event_name: "workflow_dispatch",
  workflow_ref:
    "acecore-systems/aceserver-portal/.github/workflows/seo-content.yml@refs/heads/main",
  workflow_sha: "a".repeat(40),
  run_id: "123",
  run_attempt: "1",
};
async function request(overrides = {}, audience = SEO_RUNNER_AUDIENCE) {
  const token = await new SignJWT({ ...claims, ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "seo-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
  return new Request(SEO_RUNNER_AUDIENCE + "/jobs/test", {
    headers: { Authorization: "Bearer " + token },
  });
}
describe("SEO OIDC separation", () => {
  it("accepts only the registered SEO workflow and retains its immutable commit/run", async () => {
    expect(await authenticateRunner(await request(), env, true)).toMatchObject({
      runId: "123",
      workflowSha: "a".repeat(40),
      repository: claims.repository,
    });
  });
  it("separates SEO and ordinary CMS audiences/workflow paths in both directions", async () => {
    await expect(
      authenticateRunner(
        await request({}, "https://cms-ai.acecore.net/runner"),
        env,
        true,
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      authenticateRunner(
        await request({
          workflow_ref:
            claims.repository + "/.github/workflows/cms-ai.yml@refs/heads/main",
        }),
        env,
        true,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      authenticateRunner(await request(), env),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("rejects another repository/ref/event, reruns and missing source/run claims", async () => {
    for (const overrides of [
      { repository: "evil/other" },
      { ref: "refs/heads/codex/other" },
      { event_name: "pull_request" },
      { run_attempt: "2" },
      { workflow_sha: "main" },
      { run_id: "" },
    ])
      await expect(
        authenticateRunner(await request(overrides), env, true),
      ).rejects.toMatchObject({ status: 403 });
  });
});
