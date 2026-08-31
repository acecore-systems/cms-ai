import { authenticateAdminRequest } from "./auth.ts";
import {
  countEnabledAdmins,
  getMembership,
  listMemberships,
  revokeMembership,
  setMembership,
} from "./db.ts";
import type { AppEnv } from "./env.ts";
import {
  assertSameOrigin,
  HttpError,
  json,
  methodNotAllowed,
  normalizeEmail,
  readJsonObject,
  requiredText,
} from "./http.ts";
import { parseRole } from "./models.ts";
import { getSiteById, SITES, type SiteConfig } from "./sites.ts";

const PREFIX = "/admin/api/";

export async function handleAdminApiRequest(request: Request, env: AppEnv) {
  const route = parseRoute(new URL(request.url).pathname);

  if (!route) {
    return json({ message: "CMS AI管理APIのURLを確認してください。" }, 404);
  }

  const identity = await authenticateAdminRequest(request, env);

  if (route === "session" || route === "sites") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const sites = await getManagedSites(env, identity.email);
    return json({ sites: sites.map(serializeSite) });
  }

  if (request.method === "GET") {
    const site = getRequiredSite(
      new URL(request.url).searchParams.get("siteId"),
    );
    await requireSiteAdmin(env, site, identity.email);
    return json({ memberships: await listMemberships(env, site.id) });
  }

  if (request.method !== "PUT" && request.method !== "DELETE") {
    return methodNotAllowed(["GET", "PUT", "DELETE"]);
  }

  assertSameOrigin(request);
  const body = await readJsonObject(request);
  const site = getRequiredSite(requiredText(body.siteId, 80));
  await requireSiteAdmin(env, site, identity.email);
  const principalEmail = normalizeEmail(body.principalEmail);

  if (request.method === "DELETE") {
    if (principalEmail === identity.email) {
      throw new HttpError(409, "自分自身のadmin権限は削除できません。");
    }

    await assertNotLastAdmin(env, site.id, principalEmail);
    const revoked = await revokeMembership(env, {
      actorEmail: identity.email,
      principalEmail,
      siteId: site.id,
    });

    return json({ revoked });
  }

  const role = parseRole(body.role);

  if (principalEmail === identity.email && role !== "admin") {
    throw new HttpError(409, "自分自身のadmin権限は変更できません。");
  }

  if (role !== "admin") {
    await assertNotLastAdmin(env, site.id, principalEmail);
  }

  const membership = await setMembership(env, {
    actorEmail: identity.email,
    principalEmail,
    role,
    siteId: site.id,
  });

  return json({ membership });
}

async function getManagedSites(env: AppEnv, email: string) {
  const memberships = await Promise.all(
    SITES.map(async (site) => ({
      membership: await getMembership(env, site.id, email),
      site,
    })),
  );

  return memberships
    .filter(
      ({ membership }) => membership?.enabled && membership.role === "admin",
    )
    .map(({ site }) => site);
}

async function requireSiteAdmin(env: AppEnv, site: SiteConfig, email: string) {
  const membership = await getMembership(env, site.id, email);

  if (!membership?.enabled || membership.role !== "admin") {
    throw new HttpError(403, "このサイトの権限を管理できません。");
  }
}

async function assertNotLastAdmin(
  env: AppEnv,
  siteId: string,
  principalEmail: string,
) {
  const current = await getMembership(env, siteId, principalEmail);

  if (
    current?.enabled &&
    current.role === "admin" &&
    (await countEnabledAdmins(env, siteId)) <= 1
  ) {
    throw new HttpError(409, "最後のadmin権限は削除・変更できません。");
  }
}

function getRequiredSite(value: unknown) {
  const siteId = typeof value === "string" ? value.trim() : "";
  const site = getSiteById(siteId);

  if (!site) throw new HttpError(400, "対象サイトを確認してください。");
  return site;
}

function serializeSite(site: SiteConfig) {
  return {
    canonicalUrl: site.canonicalUrl,
    displayName: site.displayName,
    id: site.id,
    repository: site.repository,
  };
}

function parseRoute(pathname: string) {
  if (!pathname.startsWith(PREFIX)) return null;
  const parts = pathname.slice(PREFIX.length).split("/").filter(Boolean);

  if (parts.length !== 1) return null;
  if (parts[0] === "session") return "session" as const;
  if (parts[0] === "sites") return "sites" as const;
  if (parts[0] === "memberships") return "memberships" as const;
  return null;
}
