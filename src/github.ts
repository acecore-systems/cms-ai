import { importPKCS8, SignJWT } from "jose";

import type { AppEnv } from "./env.ts";
import { HttpError } from "./http.ts";
import type { Job } from "./models.ts";
import type { SiteConfig } from "./sites.ts";

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

async function createInstallationToken(env: AppEnv, site: SiteConfig) {
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
        permissions: { actions: "write" },
        repositories: [repositoryName],
      }),
      headers: githubHeaders(appJwt),
      method: "POST",
    },
  );
  const body: unknown = await response.json().catch(() => null);

  if (
    !response.ok ||
    !body ||
    typeof body !== "object" ||
    typeof (body as { token?: unknown }).token !== "string"
  ) {
    const details = await readGitHubError(response, body);
    throw new HttpError(
      502,
      `CMS AI GitHub Appを認証できませんでした。${details}`,
    );
  }

  return (body as { token: string }).token;
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
