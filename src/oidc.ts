import { createRemoteJWKSet, jwtVerify } from "jose";

import type { AppEnv } from "./env.ts";
import { HttpError } from "./http.ts";
import { getSiteByRepository, type SiteConfig } from "./sites.ts";

const DEFAULT_ISSUER = "https://token.actions.githubusercontent.com";
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export type RunnerIdentity = {
  repository: string;
  runId: string | null;
  site: SiteConfig;
};

export async function authenticateRunner(
  request: Request,
  env: AppEnv,
): Promise<RunnerIdentity> {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "");

  if (!token || token === authorization) {
    throw new HttpError(401, "GitHub Actionsの認証が必要です。");
  }

  const issuer = getIssuer(env);
  const audience = String(env.CMS_AI_RUNNER_AUDIENCE || "").trim();

  if (!audience) {
    throw new HttpError(503, "CMS AI runnerのaudienceが未設定です。");
  }

  let payload;

  try {
    const verified = await jwtVerify(token, getJwks(issuer), {
      algorithms: ["RS256"],
      audience,
      issuer,
    });
    payload = verified.payload;
  } catch {
    throw new HttpError(401, "GitHub Actionsの認証を確認できません。");
  }

  const repository = String(payload.repository || "");
  const site = getSiteByRepository(repository);

  if (!site) {
    throw new HttpError(
      403,
      "このrepositoryのCMS AI実行は許可されていません。",
    );
  }

  const expectedWorkflowRef = `${site.repository}/${site.workflowPath}@refs/heads/${site.branch}`;

  if (
    payload.event_name !== "workflow_dispatch" ||
    payload.ref !== `refs/heads/${site.branch}` ||
    payload.workflow_ref !== expectedWorkflowRef
  ) {
    throw new HttpError(403, "このGitHub Actions実行は許可されていません。");
  }

  return {
    repository,
    runId:
      typeof payload.run_id === "string"
        ? payload.run_id
        : typeof payload.run_id === "number"
          ? String(payload.run_id)
          : null,
    site,
  };
}

function getIssuer(env: AppEnv) {
  const configured = String(env.CMS_AI_GITHUB_OIDC_ISSUER || "").trim();

  if (!configured) return DEFAULT_ISSUER;

  try {
    const url = new URL(configured);

    return url.protocol === "https:" && !url.username && !url.password
      ? url.origin
      : DEFAULT_ISSUER;
  } catch {
    return DEFAULT_ISSUER;
  }
}

function getJwks(issuer: string) {
  let jwks = jwksByIssuer.get(issuer);

  if (!jwks) {
    jwks = createRemoteJWKSet(new URL("/.well-known/jwks", issuer + "/"));
    jwksByIssuer.set(issuer, jwks);
  }

  return jwks;
}
