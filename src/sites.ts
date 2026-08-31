export type CommandSpec = {
  args: readonly string[];
  command: string;
};

export type SiteConfig = {
  branch: string;
  canonicalUrl: string;
  defaultAccessAudiences: readonly string[];
  displayName: string;
  hostnames: readonly string[];
  id: string;
  packageDirectory: string;
  projectRoot: string;
  repository: string;
  sourcePrefixes: readonly string[];
  validationCommands: readonly CommandSpec[];
  workflowPath: string;
  writablePrefixes: readonly string[];
};

const standardValidation: CommandSpec[] = [
  { command: "npm", args: ["run", "format:check"] },
  { command: "npm", args: ["run", "validate:content"] },
  { command: "npm", args: ["run", "test:cms"] },
  { command: "npm", args: ["run", "typecheck:functions"] },
  { command: "npm", args: ["run", "build"] },
];

const ROOT_SOURCE_PREFIXES = ["src/", "public/", "docs/"];
const ROOT_WRITABLE_PREFIXES = ["src/", "public/", "docs/"];

export const SITES = [
  {
    branch: "main",
    canonicalUrl: "https://hatt.acecore.net/",
    defaultAccessAudiences: [
      "044fc6624d4c84e5bcf78bc8a0ac1b505c9d2227cb6b1dba4dd6c4e10d4579d4",
    ],
    displayName: "Hatt",
    hostnames: [
      "hatt.acecore.net",
      "www.hatt.acecore.net",
      "homepage-hatt.pages.dev",
      "*.homepage-hatt.pages.dev",
    ],
    id: "homepage-hatt",
    packageDirectory: ".",
    projectRoot: "",
    repository: "acecore-systems/homepage-hatt",
    sourcePrefixes: ROOT_SOURCE_PREFIXES,
    validationCommands: standardValidation,
    workflowPath: ".github/workflows/cms-ai.yml",
    writablePrefixes: ROOT_WRITABLE_PREFIXES,
  },
  {
    branch: "main",
    canonicalUrl: "https://cherry.acecore.net/",
    defaultAccessAudiences: [
      "4bb38bad64a6d2b8825d8f7428c9f4432641afaa65308e168e2499a9ae61b523",
    ],
    displayName: "Cherry",
    hostnames: [
      "cherry.acecore.net",
      "homepage-cherry.pages.dev",
      "*.homepage-cherry.pages.dev",
    ],
    id: "homepage-cherry",
    packageDirectory: ".",
    projectRoot: "",
    repository: "acecore-systems/homepage-cherry",
    sourcePrefixes: ROOT_SOURCE_PREFIXES,
    validationCommands: standardValidation,
    workflowPath: ".github/workflows/cms-ai.yml",
    writablePrefixes: ROOT_WRITABLE_PREFIXES,
  },
  {
    branch: "main",
    canonicalUrl: "https://acecore.net/",
    defaultAccessAudiences: [],
    displayName: "Acecore",
    hostnames: [
      "acecore.net",
      "www.acecore.net",
      "acecore-net.pages.dev",
      "*.acecore-net.pages.dev",
    ],
    id: "acecore-net",
    packageDirectory: ".",
    projectRoot: "",
    repository: "acecore-systems/acecore-net",
    sourcePrefixes: ROOT_SOURCE_PREFIXES,
    validationCommands: standardValidation,
    workflowPath: ".github/workflows/cms-ai.yml",
    writablePrefixes: ROOT_WRITABLE_PREFIXES,
  },
  {
    branch: "main",
    canonicalUrl: "https://systems.acecore.net/",
    defaultAccessAudiences: [],
    displayName: "Acecore Systems",
    hostnames: [
      "systems.acecore.net",
      "acecore-systems.pages.dev",
      "*.acecore-systems.pages.dev",
    ],
    id: "acecore-systems",
    packageDirectory: ".",
    projectRoot: "",
    repository: "acecore-systems/acecore-systems",
    sourcePrefixes: ROOT_SOURCE_PREFIXES,
    validationCommands: standardValidation,
    workflowPath: ".github/workflows/cms-ai.yml",
    writablePrefixes: ROOT_WRITABLE_PREFIXES,
  },
  {
    branch: "main",
    canonicalUrl: "https://asv.acecore.net/",
    defaultAccessAudiences: [],
    displayName: "Aceserver Portal",
    hostnames: [
      "asv.acecore.net",
      "aceserver-portal.pages.dev",
      "*.aceserver-portal.pages.dev",
    ],
    id: "aceserver-portal",
    packageDirectory: ".",
    projectRoot: "",
    repository: "acecore-systems/aceserver-portal",
    sourcePrefixes: ROOT_SOURCE_PREFIXES,
    validationCommands: standardValidation,
    workflowPath: ".github/workflows/cms-ai.yml",
    writablePrefixes: ROOT_WRITABLE_PREFIXES,
  },
  {
    branch: "main",
    canonicalUrl: "https://asv-wiki.acecore.net/",
    defaultAccessAudiences: [
      "54a3701fe2f2c8c6d40227451a19e966cacc2dd7407c48df15f1d7126654485d",
    ],
    displayName: "Aceserver Wiki",
    hostnames: [
      "asv-wiki.acecore.net",
      "aceserver-wiki-astro.pages.dev",
      "*.aceserver-wiki-astro.pages.dev",
    ],
    id: "aceserver-wiki",
    packageDirectory: "poc/astro-sveltia",
    projectRoot: "poc/astro-sveltia/",
    repository: "acecore-systems/aceserver-wiki",
    sourcePrefixes: [
      "poc/astro-sveltia/src/",
      "poc/astro-sveltia/public/",
      "poc/astro-sveltia/docs/",
    ],
    validationCommands: [
      { command: "npm", args: ["run", "check"] },
      { command: "npm", args: ["test"] },
      { command: "npm", args: ["run", "build"] },
    ],
    workflowPath: ".github/workflows/cms-ai.yml",
    writablePrefixes: [
      "poc/astro-sveltia/src/",
      "poc/astro-sveltia/public/",
      "poc/astro-sveltia/docs/",
    ],
  },
] as const satisfies readonly SiteConfig[];

export function getSiteById(siteId: string): SiteConfig | null {
  return SITES.find((site) => site.id === siteId) || null;
}

export function getSiteByRepository(repository: string): SiteConfig | null {
  return SITES.find((site) => site.repository === repository) || null;
}

export function getSiteByHostname(hostname: string): SiteConfig | null {
  const normalizedHostname = hostname.trim().toLowerCase();

  return (
    SITES.find((site) =>
      site.hostnames.some((pattern) =>
        hostnameMatches(pattern, normalizedHostname),
      ),
    ) || null
  );
}

export function getSiteAudiences(site: SiteConfig, value: string | undefined) {
  const configured = parseAudienceMap(value)[site.id] || [];
  return Array.from(new Set([...site.defaultAccessAudiences, ...configured]));
}

export function isSiteWritablePath(site: SiteConfig, value: string) {
  const path = normalizeRepositoryPath(value);

  if (
    !path ||
    !site.writablePrefixes.some((prefix) => path.startsWith(prefix))
  ) {
    return false;
  }

  const relativePath = site.projectRoot
    ? path.slice(site.projectRoot.length)
    : path;

  if (
    !relativePath ||
    !hasAllowedTextExtension(relativePath) ||
    isSensitivePath(relativePath)
  )
    return false;

  return ![
    ".github/",
    "functions/",
    "migrations/",
    "scripts/",
    "tests/",
    "public/admin/",
    "public/uploads/",
    "src/pages/api/",
  ].some((prefix) => relativePath.startsWith(prefix));
}

export function isSiteSourcePath(site: SiteConfig, value: string) {
  const path = normalizeRepositoryPath(value);

  if (!path || !site.sourcePrefixes.some((prefix) => path.startsWith(prefix))) {
    return false;
  }

  const relativePath = site.projectRoot
    ? path.slice(site.projectRoot.length)
    : path;

  return (
    hasAllowedTextExtension(relativePath) &&
    !isSensitivePath(relativePath) &&
    ![
      ".github/",
      "functions/",
      "migrations/",
      "scripts/",
      "tests/",
      "public/admin/",
      "public/uploads/",
    ].some((prefix) => relativePath.startsWith(prefix))
  );
}

function isSensitivePath(path: string) {
  return (
    /^src\/middleware(?:\.|\/)/i.test(path) ||
    /^src\/env\.d\.ts$/i.test(path) ||
    /(^|\/)(auth|checkout|oauth|payments?|secrets?|stripe|webhook)([._/-]|$)/i.test(
      path,
    )
  );
}

export function normalizeRepositoryPath(value: string) {
  const path = value.replace(/\\/g, "/").replace(/^\/+/, "");

  if (
    !path ||
    path.length > 240 ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return null;
  }

  return path;
}

function hostnameMatches(pattern: string, hostname: string) {
  const normalizedPattern = pattern.trim().toLowerCase();

  return normalizedPattern.startsWith("*.")
    ? hostname.endsWith(normalizedPattern.slice(1))
    : normalizedPattern === hostname;
}

function hasAllowedTextExtension(path: string) {
  return /\.(astro|css|js|json|md|mjs|ts|tsx)$/i.test(path);
}

function parseAudienceMap(value: string | undefined): Record<string, string[]> {
  if (!value) return {};

  try {
    const parsed: unknown = JSON.parse(value);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};

    const result: Record<string, string[]> = {};

    for (const [siteId, audiences] of Object.entries(parsed)) {
      if (!Array.isArray(audiences)) continue;

      result[siteId] = audiences
        .filter((audience): audience is string => typeof audience === "string")
        .map((audience) => audience.trim())
        .filter((audience) => /^[0-9a-f]{64}$/i.test(audience));
    }

    return result;
  } catch {
    return {};
  }
}
