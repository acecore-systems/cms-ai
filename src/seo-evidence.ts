import type { TableContext } from "./seo-table-claims.ts";
// URLs here are reference destinations, never Worker fetch targets. Hosted search
// performs retrieval; credentials/source files are never sent to those origins.
export const LEARN_VIEW_URL_INSTRUCTION =
  "URL policy2 permits only an additional exact HTTPS URL of the form https://learn.microsoft.com/en-us/minecraft/creator/documents/<lowercase alphanumeric-or-hyphen path segments>?view=minecraft-bedrock-stable. No other query, duplicate key, encoding, fragment, port or credentials. Preserve the exact search-source URL; never remove or rewrite query/path. This URL format alone does not prove source support.";
export function referenceUrl(value: unknown, policy = 1): string {
  if (![1, 2].includes(policy)) throw new Error("seo_research_url");
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\s\\<>"'`\u0000-\u001f]/u.test(value)
  )
    throw new Error("seo_research_url");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    (url.search &&
      !(
        policy === 2 &&
        /^https:\/\/learn\.microsoft\.com\/en-us\/minecraft\/creator\/documents\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*[a-z0-9]+(?:-[a-z0-9]+)*\/?\?view=minecraft-bedrock-stable$/.test(
          value,
        )
      )) ||
    url.hash ||
    !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/i.test(
      url.hostname,
    ) ||
    url.hostname.endsWith(".arpa") ||
    url.hostname.includes("xn--")
  )
    throw new Error("seo_research_url");
  return value;
}

export type ResearchEvidence = {
  sourceRecovery?: { version: 2; url: string; proofSha256: string };
  version: 1;
  tableContext?: TableContext;
  referencePolicy?: 2;
  checkedAt: string;
  sourceSha256: string;
  responseId: string;
  queries: string[];
  sources: {
    url: string;
    title: string;
    claim: string;
    excerpt: string;
    assessment: "supports";
  }[];
};

export function evidenceReferences(evidence: ResearchEvidence): string[] {
  return evidence.sources.map((source) =>
    referenceUrl(source.url, evidence.referencePolicy ?? 1),
  );
}
