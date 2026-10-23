import { importPKCS8, SignJWT } from "jose";

import type { AppEnv } from "./env.ts";
import { HttpError } from "./http.ts";
import type { Job } from "./models.ts";
import type { SiteConfig } from "./sites.ts";
import { SEO_WORKFLOW_PATH } from "./sites.ts";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

export async function dispatchCmsAiJob(
  env: AppEnv,
  site: SiteConfig,
  job: Job,
) {
  const token = await createInstallationToken(env, site);
  const workflow = encodeURIComponent(site.workflowPath);
  const response = await fetch(
    `${GITHUB_API}/repos/${site.repository}/actions/workflows/${workflow}/dispatches`,
    {
      body: JSON.stringify({
        inputs: {
          conversation_id: job.conversationId,
          job_id: job.id,
        },
        ref: site.branch,
      }),
      headers: githubHeaders(token),
      method: "POST",
    },
  );

  if (response.status !== 204) {
    const details = await readGitHubError(response);
    throw new HttpError(
      502,
      `GitHub Actionsを開始できませんでした。${details}`,
    );
  }
}

async function createInstallationToken(
  env: AppEnv,
  site: SiteConfig,
  deadline?: number,
  purpose: "dispatch" | "eligibility" = "dispatch",
) {
  const appJwt = await createAppJwt(env);
  const installationId = String(
    env.CMS_AI_GITHUB_APP_INSTALLATION_ID || "",
  ).trim();

  if (!/^\d+$/.test(installationId)) {
    throw new HttpError(503, "CMS AI GitHub Appの設定を確認できません。");
  }

  const repositoryName = site.repository.split("/").at(-1) || "";
  const response = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      body: JSON.stringify({
        permissions:
          purpose === "eligibility"
            ? { contents: "read", pull_requests: "read" }
            : { actions: "write" },
        repositories: [repositoryName],
      }),
      headers: githubHeaders(appJwt),
      method: "POST",
      ...(deadline === undefined
        ? {}
        : {
            signal: AbortSignal.timeout(
              Math.max(1, Math.min(30_000, deadline - Date.now())),
            ),
          }),
    },
  );
  const body: unknown = await response.json().catch(() => null);

  if (
    !response.ok ||
    !body ||
    typeof body !== "object" ||
    typeof (body as { token?: unknown }).token !== "string"
  ) {
    if (purpose === "eligibility") {
      throw new SeoRepositoryReadError(
        response.status === 401
          ? "token_authentication"
          : [403, 422].includes(response.status)
            ? "token_permission_denied"
            : "token_unavailable",
      );
    }
    const details = await readGitHubError(response, body);
    throw new HttpError(
      502,
      `CMS AI GitHub Appを認証できませんでした。${details}`,
    );
  }

  if (purpose === "eligibility") {
    const permissions = (body as { permissions?: Record<string, unknown> })
      .permissions;
    if (
      !permissions ||
      permissions.contents !== "read" ||
      permissions.pull_requests !== "read" ||
      Object.entries(permissions).some(
        ([key, value]) =>
          !["contents", "pull_requests", "metadata"].includes(key) &&
          value !== "none",
      )
    )
      throw new SeoRepositoryReadError("token_scope_mismatch");
  }
  return (body as { token: string }).token;
}

export class SeoRepositoryReadError extends Error {
  constructor(
    readonly code:
      | "token_authentication"
      | "token_permission_denied"
      | "token_unavailable"
      | "token_scope_mismatch"
      | "read_authentication"
      | "read_forbidden"
      | "read_unavailable"
      | "rate_evidence_missing"
      | "rate_insufficient"
      | "request_bound"
      | "unknown",
  ) {
    super("seo_eligibility_unknown");
  }
}

// Read-token permissions are separate from actions-only dispatch permissions.
// At most six sites: 600 GETs + six token requests per collection (no retry).
export function seoRepositoryReader(
  env: AppEnv,
  site: SiteConfig,
  deadline: number,
): typeof fetch {
  let token: Promise<string> | undefined;
  let requests = 0;
  const prefix = `${GITHUB_API}/repos/${site.repository}/`;
  return async (input, init) => {
    try {
      const url = String(input);
      if (
        !url.startsWith(prefix) ||
        (init?.method && init.method !== "GET") ||
        ++requests > 100 ||
        Date.now() >= deadline
      )
        throw new SeoRepositoryReadError("request_bound");
      const suffix = url.slice(prefix.length);
      if (
        !/^(?:commits\/main|git\/trees\/[a-f0-9]{40}\?recursive=1|git\/blobs\/[a-f0-9]{40}|pulls(?:\/[1-9][0-9]*(?:\/files)?)?(?:\?[^#]*)?)$/.test(
          suffix,
        )
      )
        throw new Error();
      token ??= createInstallationToken(env, site, deadline, "eligibility");
      const response = await fetch(url, {
        ...init,
        method: "GET",
        headers: githubHeaders(await token),
        redirect: "error",
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(10000, deadline - Date.now())),
        ),
      });
      // Fail closed on shared installation exhaustion, missing rate evidence,
      // authentication failures and secondary limits. Never fall back anonymously.
      const remaining = response.headers.get("x-ratelimit-remaining");
      const limit = response.headers.get("x-ratelimit-limit");
      let code: SeoRepositoryReadError["code"] | undefined;
      if (response.status === 401) code = "read_authentication";
      else if (response.status === 403) code = "read_forbidden";
      else if (response.status === 429) code = "rate_insufficient";
      else if (!response.ok) code = "read_unavailable";
      else if (
        !remaining ||
        !limit ||
        !/^\d+$/.test(remaining) ||
        !/^\d+$/.test(limit)
      )
        code = "rate_evidence_missing";
      else if (Number(limit) < 5000 || Number(remaining) < 606)
        code = "rate_insufficient";
      if (code) {
        await response.body?.cancel();
        throw new SeoRepositoryReadError(code);
      }
      return response;
    } catch (error) {
      throw error instanceof SeoRepositoryReadError
        ? error
        : new SeoRepositoryReadError("unknown");
    }
  };
}

// Same actions-only installation token; no repository contents are read here.
export async function dispatchSeoEditorialJob(
  env: AppEnv,
  site: SiteConfig,
  runId: string,
  jobId: string,
  deadline: number,
) {
  const token = await createInstallationToken(env, site, deadline);
  if (Date.now() >= deadline) throw new Error("seo_deadline");
  const response = await fetch(
    `${GITHUB_API}/repos/${site.repository}/actions/workflows/${encodeURIComponent(SEO_WORKFLOW_PATH)}/dispatches`,
    {
      method: "POST",
      headers: githubHeaders(token),
      body: JSON.stringify({
        ref: site.branch,
        inputs: { run_id: runId, job_id: jobId },
      }),
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(30_000, deadline - Date.now())),
      ),
    },
  );
  if (response.status !== 204) throw new Error("seo_dispatch_failed");
}

async function createAppJwt(env: AppEnv) {
  const clientId = String(env.CMS_AI_GITHUB_APP_CLIENT_ID || "").trim();
  const configuredPrivateKey = String(env.CMS_AI_GITHUB_APP_PRIVATE_KEY || "")
    .replace(/\\n/g, "\n")
    .trim();

  if (!clientId || !configuredPrivateKey) {
    throw new HttpError(503, "CMS AI GitHub Appの設定を確認できません。");
  }

  try {
    const privateKey = normalizePrivateKey(configuredPrivateKey);
    const key = await importPKCS8(privateKey, "RS256");
    const now = Math.floor(Date.now() / 1000);

    return await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(clientId)
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 540)
      .sign(key);
  } catch {
    throw new HttpError(503, "CMS AI GitHub Appの秘密鍵を確認できません。");
  }
}

function normalizePrivateKey(privateKey: string) {
  if (privateKey.includes("-----BEGIN PRIVATE KEY-----")) {
    return privateKey;
  }

  const match = privateKey.match(
    /^-----BEGIN RSA PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END RSA PRIVATE KEY-----$/,
  );
  if (!match) throw new Error("Unsupported GitHub App private key format.");

  const pkcs1 = decodeBase64(match[1].replace(/\s/g, ""));
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaEncryptionAlgorithm = Uint8Array.of(
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
  );
  const privateKeyOctetString = encodeDerValue(0x04, pkcs1);
  const pkcs8 = encodeDerValue(
    0x30,
    concatBytes(version, rsaEncryptionAlgorithm, privateKeyOctetString),
  );

  return encodePem("PRIVATE KEY", pkcs8);
}

function encodeDerValue(tag: number, value: Uint8Array) {
  return concatBytes(Uint8Array.of(tag), encodeDerLength(value.length), value);
}

function encodeDerLength(length: number) {
  if (length < 0x80) return Uint8Array.of(length);

  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining >>>= 8) {
    bytes.unshift(remaining & 0xff);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concatBytes(...parts: Uint8Array[]) {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodePem(label: string, value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

function githubHeaders(token: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "acecore-cms-ai",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

async function readGitHubError(response: Response, parsedBody?: unknown) {
  const body =
    parsedBody === undefined
      ? await response.json().catch(() => null)
      : parsedBody;
  const message =
    body &&
    typeof body === "object" &&
    typeof (body as { message?: unknown }).message === "string"
      ? (body as { message: string }).message.trim().slice(0, 240)
      : "";

  return message
    ? ` (${response.status}: ${message})`
    : ` (${response.status})`;
}
