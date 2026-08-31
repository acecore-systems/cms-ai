import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { authenticateSiteRequest } from "../src/auth.ts";
import type { AppEnv } from "../src/env.ts";
import { authenticateRunner } from "../src/oidc.ts";

const accessIssuer = "https://access.cms-ai.test";
const actionsIssuer = "https://actions.cms-ai.test";
const accessAudience =
  "044fc6624d4c84e5bcf78bc8a0ac1b505c9d2227cb6b1dba4dd6c4e10d4579d4";
const actionsAudience = "https://cms-ai.acecore.net/runner";
let accessPrivateKey: CryptoKey;
let actionsPrivateKey: CryptoKey;

beforeAll(async () => {
  const accessKeys = await generateKeyPair("RS256", { extractable: true });
  const actionsKeys = await generateKeyPair("RS256", { extractable: true });
  accessPrivateKey = accessKeys.privateKey;
  actionsPrivateKey = actionsKeys.privateKey;
  const accessJwk = await exportJWK(accessKeys.publicKey);
  const actionsJwk = await exportJWK(actionsKeys.publicKey);
  Object.assign(accessJwk, { alg: "RS256", kid: "access-key", use: "sig" });
  Object.assign(actionsJwk, { alg: "RS256", kid: "actions-key", use: "sig" });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === accessIssuer + "/cdn-cgi/access/certs") {
        return Response.json({ keys: [accessJwk] });
      }
      if (url === actionsIssuer + "/.well-known/jwks") {
        return Response.json({ keys: [actionsJwk] });
      }
      throw new Error("Unexpected fetch: " + url);
    }),
  );
});

describe("authentication boundaries", () => {
  it("Access JWTとD1のsite membershipを両方確認する", async () => {
    const token = await signAccessToken(accessAudience);
    const identity = await authenticateSiteRequest(
      new Request("https://hatt.acecore.net/admin/api/ai/session", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      }),
      createEnv(),
    );

    expect(identity.email).toBe("member@example.com");
    expect(identity.site.id).toBe("homepage-hatt");
    expect(identity.membership.role).toBe("chat");
  });

  it("別audienceのAccess JWTを拒否する", async () => {
    const token = await signAccessToken("f".repeat(64));
    await expect(
      authenticateSiteRequest(
        new Request("https://hatt.acecore.net/admin/api/ai/session", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        createEnv(),
      ),
    ).rejects.toThrow(/認証を確認できません/);
  });

  it("workflow_dispatchのrepository・ref・workflowを検証する", async () => {
    const identity = await authenticateRunner(
      new Request("https://cms-ai.acecore.net/runner/jobs/example", {
        headers: { Authorization: "Bearer " + (await signActionsToken()) },
      }),
      createEnv(),
    );

    expect(identity.repository).toBe("acecore-systems/homepage-hatt");
    expect(identity.site.id).toBe("homepage-hatt");
  });

  it("未登録repositoryのOIDC tokenを拒否する", async () => {
    const token = await signActionsToken("attacker/other-repository");
    await expect(
      authenticateRunner(
        new Request("https://cms-ai.acecore.net/runner/jobs/example", {
          headers: { Authorization: "Bearer " + token },
        }),
        createEnv(),
      ),
    ).rejects.toThrow(/repository/);
  });
});

function createEnv() {
  const db = {
    prepare() {
      let values: unknown[] = [];
      return {
        bind(...nextValues: unknown[]) {
          values = nextValues;
          return this;
        },
        async first() {
          return {
            created_at: new Date().toISOString(),
            created_by: "bootstrap@example.com",
            enabled: 1,
            principal_email: values[1],
            role: "chat",
            site_id: values[0],
            updated_at: new Date().toISOString(),
          };
        },
      };
    },
  };

  return {
    CMS_AI_ACCESS_TEAM_DOMAIN: accessIssuer,
    CMS_AI_DB: db,
    CMS_AI_GITHUB_OIDC_ISSUER: actionsIssuer,
    CMS_AI_RUNNER_AUDIENCE: actionsAudience,
    CMS_AI_SITE_AUDIENCES: "{}",
  } as unknown as AppEnv;
}

function signAccessToken(audience: string) {
  return new SignJWT({ email: "member@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "access-key" })
    .setIssuer(accessIssuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(accessPrivateKey);
}

function signActionsToken(repository = "acecore-systems/homepage-hatt") {
  return new SignJWT({
    event_name: "workflow_dispatch",
    ref: "refs/heads/main",
    repository,
    run_id: "12345",
    workflow_ref: repository + "/.github/workflows/cms-ai.yml@refs/heads/main",
  })
    .setProtectedHeader({ alg: "RS256", kid: "actions-key" })
    .setIssuer(actionsIssuer)
    .setAudience(actionsAudience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(actionsPrivateKey);
}
