// URLs here are reference destinations, never Worker fetch targets. Hosted search
// performs retrieval; credentials/source files are never sent to those origins.
export function referenceUrl(value: unknown): string {
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
    url.search ||
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
  version: 1;
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
  return evidence.sources.map((source) => referenceUrl(source.url));
}
