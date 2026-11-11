import { sha256 } from "./seo-hash.ts";
import { preferredPublisher } from "./seo-publishers.ts";
import {
  isNewExternalUrl,
  type ExternalScope,
} from "./seo-external-sources.ts";
import { focusedInput, type ResearchPlan } from "./seo-research-plan.ts";
import { parse } from "parse5";

// Versioned static text projection: parse HTML, discard non-content and
// explicitly hidden subtrees, join text nodes, collapse Unicode whitespace.
// External CSS and JavaScript are not executed.
export function parallelVisibleText(body: Uint8Array) {
  const html = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: false,
  }).decode(body);
  const document = parse(html);
  const parts: string[] = [];
  const visit = (node: any) => {
    const tag = String(node.tagName || "").toLowerCase();
    if (
      ["head", "script", "style", "noscript", "template", "svg"].includes(tag)
    )
      return;
    const attrs = new Map<string, string>(
      (node.attrs || []).map((a: any) => [
        String(a.name).toLowerCase(),
        String(a.value),
      ]),
    );
    if (
      attrs.has("hidden") ||
      attrs.get("aria-hidden") === "true" ||
      /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(
        attrs.get("style") || "",
      )
    )
      return;
    const block = [
      "p",
      "div",
      "main",
      "article",
      "section",
      "br",
      "li",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "tr",
    ].includes(tag);
    if (block) parts.push("\n");
    if (node.nodeName === "#text")
      parts.push(String(node.value).replace(/\s+/gu, " "));
    for (const child of node.childNodes || []) visit(child);
    if (block) parts.push("\n");
  };
  visit(document);
  return parts
    .join("")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n+/g, "\n")
    .trim();
}

// New controller evidence, never a provider citation. The caller must persist
// and bind the original Parallel result, raw body and model response before use.
export async function parallelEvidence(input: {
  source: string;
  sourceSha256: string;
  scope: ExternalScope;
  plan: ResearchPlan;
  searchedUrls: string[];
  selectedUrl: string;
  candidateTitle: string;
  suppliedText: string;
  body: Uint8Array;
  bodySha256: string;
  retrievedAt: number;
  deadline: number;
  modelResponseId: string;
  result: unknown;
}) {
  const value = input.result as any;
  const body = input.body;
  if (!body.length || body.length > 262144)
    throw Error("seo_parallel_evidence");
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", body)),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (
    digest !== input.bodySha256 ||
    !Number.isSafeInteger(input.retrievedAt) ||
    input.retrievedAt > Date.now() ||
    input.retrievedAt >= input.deadline ||
    !/^(?:resp_|chatcmpl-)[A-Za-z0-9_-]+$/.test(input.modelResponseId) ||
    !preferredPublisher(input.selectedUrl) ||
    !isNewExternalUrl(input.selectedUrl, input.source, input.scope, 2) ||
    !Array.isArray(input.searchedUrls) ||
    !input.searchedUrls.includes(input.selectedUrl) ||
    new Set(input.searchedUrls).size !== input.searchedUrls.length ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !==
      "assessment,claimId,excerpt,title,url,verdict" ||
    value.verdict !== "verified" ||
    value.assessment !== "supports" ||
    value.claimId !== input.plan.claimId ||
    value.url !== input.selectedUrl ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    value.title.length > 300 ||
    value.title !== input.candidateTitle ||
    typeof value.excerpt !== "string" ||
    value.excerpt.length < 20 ||
    value.excerpt.length > 800 ||
    /[<>\r\n]/.test(value.excerpt)
  )
    throw Error("seo_parallel_evidence");
  focusedInput(input.source, input.sourceSha256, input.plan);
  if (
    (await sha256(input.source.replace(/\r\n/g, "\n"))) !== input.sourceSha256
  )
    throw Error("seo_parallel_evidence");
  const visible = parallelVisibleText(body);
  if (
    !input.suppliedText ||
    input.suppliedText.length > 2000 ||
    !visible.startsWith(input.suppliedText) ||
    !input.suppliedText.includes(value.excerpt)
  )
    throw Error("seo_parallel_evidence");
  const excerptStart = visible.indexOf(value.excerpt);
  if (
    excerptStart < 0 ||
    visible.indexOf(value.excerpt, excerptStart + 1) !== -1
  )
    throw Error("seo_parallel_evidence");
  return {
    version: 2 as const,
    ...(input.plan.tableContext
      ? { tableContext: input.plan.tableContext }
      : {}),
    sourceSha256: input.sourceSha256,
    responseId: input.modelResponseId,
    queries: input.plan.queries,
    source: {
      url: input.selectedUrl,
      bodySha256: input.bodySha256,
      textVersion: 1 as const,
      textSha256: await sha256(visible),
      retrievedAt: input.retrievedAt,
      excerptStart,
      excerptEnd: excerptStart + value.excerpt.length,
      title: value.title,
      excerpt: value.excerpt,
      claim: input.plan.target?.quote ?? input.plan.claimMarkdown,
      assessment: "supports" as const,
    },
  };
}
