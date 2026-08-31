import { createRemoteJWKSet, jwtVerify } from "jose";

import { getMembership } from "./db.ts";
import type { AppEnv } from "./env.ts";
import { HttpError } from "./http.ts";
import type { Membership } from "./models.ts";
import {
  getSiteAudiences,
  getSiteByHostname,
  type SiteConfig,
} from "./sites.ts";

const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";
const DEFAULT_ADMIN_HOSTNAME = "cms-ai.acecore.net";
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export type SiteIdentity = {
  email: string;
  membership: Membership;
  site: SiteConfig;
};

export type AdminIdentity = {
  email: string;
};

export async function authenticateSiteRequest(
  request: Request,
  env: AppEnv,
): Promise<SiteIdentity> {
  const site = getSiteByHostname(new URL(request.url).hostname);

  if (!site) {
    throw new HttpError(404, "このサイトではCMS AIを利用できません。");
  }

  const audiences = getSiteAudiences(site, env.CMS_AI_SITE_AUDIENCES);

  if (audiences.length === 0) {
    throw new HttpError(503, "このサイトのCMS AI認証は準備中です。");
  }

  const email = await verifyAccessIdentity(request, env, audiences);
  const membership = await getMembership(env, site.id, email);

  if (!membership?.enabled) {
    throw new HttpError(403, "このサイトのCMS AI利用権限がありません。");
  }

  return { email, membership, site };
}

export async function authenticateAdminRequest(
  request: Request,
  env: AppEnv,
): Promise<AdminIdentity> {
  const hostname = new URL(request.url).hostname.toLowerCase();

  if (
    hostname !== DEFAULT_ADMIN_HOSTNAME &&
    hostname !== "localhost" &&
    hostname !== "127.0.0.1"
  ) {
    throw new HttpError(404, "CMS AI管理画面が見つかりません。");
  }

  const audience = String(env.CMS_AI_ADMIN_ACCESS_AUD || "").trim();

  if (!/^[0-9a-f]{64}$/i.test(audience)) {
    throw new HttpError(503, "CMS AI管理画面の認証は準備中です。");
  }

  return {
    email: await verifyAccessIdentity(request, env, [audience]),
  };
}

async function verifyAccessIdentity(
  request: Request,
  env: AppEnv,
  audiences: string[],
) {
  const token = request.headers.get(ACCESS_HEADER) || "";

  if (!token) {
    throw new HttpError(401, "Cloudflare Accessへのログインが必要です。");
  }

  const issuer = getAccessIssuer(env);
  let payload;

  try {
    const verified = await jwtVerify(token, getJwks(issuer), {
      algorithms: ["RS256"],
      audience: audiences,
      issuer,
    });
    payload = verified.payload;
  } catch {
    throw new HttpError(401, "Cloudflare Accessの認証を確認できません。");
  }

  const email = String(payload.email || "")
    .trim()
    .toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw new HttpError(401, "Cloudflare Accessの利用者を確認できません。");
  }

  return email;
}

function getAccessIssuer(env: AppEnv) {
  const configured = String(env.CMS_AI_ACCESS_TEAM_DOMAIN || "").trim();

  try {
    const url = new URL(configured);

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      throw new Error("invalid Access issuer");
    }

    return url.origin;
  } catch {
    throw new HttpError(503, "Cloudflare Accessの設定を確認できません。");
  }
}

function getJwks(issuer: string) {
  let jwks = jwksByIssuer.get(issuer);

  if (!jwks) {
    jwks = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer + "/"));
    jwksByIssuer.set(issuer, jwks);
  }

  return jwks;
}
