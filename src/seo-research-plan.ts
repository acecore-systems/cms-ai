import { tableClaims, type TableContext } from "./seo-table-claims.ts";
import { externalClaimCandidate } from "./seo-claim-selection.ts";
import { fromMarkdown } from "mdast-util-from-markdown";
import { markdown, articleReferenceLinks } from "./seo-content.ts";
// IDs are scoped to the exact source bytes already bound by sourceSha256.
// AST offsets retain Markdown punctuation, inline code and emphasis verbatim.
export function researchInputs(source: string) {
  const body = markdown(source).body;
  const claims: { id: string; markdown: string }[] = [];
  const visit = (node: any) => {
    if (node.type === "paragraph") {
      const text = body.slice(
        node.position.start.offset,
        node.position.end.offset,
      );
      if (text.length >= 12 && text.length <= 800)
        claims.push({ id: "claim-" + (claims.length + 1), markdown: text });
      return;
    }
    for (const child of node.children || []) visit(child);
  };
  visit(fromMarkdown(body));
  const existingUrls = [
    ...new Set([
      ...articleReferenceLinks(source),
      ...[...source.matchAll(/https?:\/\/[^\s<>"'`)\]]+/gu)].map((m) => m[0]),
    ]),
  ].sort();
  return { claims, existingUrls };
}

export type ResearchPlan = {
  version: 1 | 2 | 3;
  tableContext?: TableContext;
  target?: { start: number; end: number; quote: string };
  sourceSha256: string;
  claimId: string;
  claimMarkdown: string;
  requiredConditions: { start: number; end: number; quote: string }[];
  anchors: string[];
  queries: string[];
};
export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "claimId", "conditions", "anchors", "queries"],
  properties: {
    verdict: { type: "string", enum: ["ready", "insufficient"] },
    claimId: { type: "string" },
    conditions: { type: "array", maxItems: 3, items: { type: "string" } },
    anchors: { type: "array", maxItems: 3, items: { type: "string" } },
    queries: { type: "array", maxItems: 2, items: { type: "string" } },
  },
};
// Only complete source sentences are selectable; never accept an arbitrary clause
// cut from a conditional/negative sentence. Markdown inline nodes are indivisible.
export function factualSentences(paragraph: string) {
  const protectedRanges: { start: number; end: number }[] = [];
  const visit = (node: any) => {
    if (["link", "inlineCode", "image"].includes(node.type))
      protectedRanges.push({
        start: node.position.start.offset,
        end: node.position.end.offset,
      });
    for (const child of node.children || []) visit(child);
  };
  visit(fromMarkdown(paragraph));
  const parts = [
    ...new Intl.Segmenter("ja", { granularity: "sentence" }).segment(paragraph),
  ];
  return parts.flatMap((part) => {
    const quote = part.segment.trim();
    const start = part.index + part.segment.indexOf(quote),
      end = start + quote.length;
    if (
      quote.length < 12 ||
      !/[。！？.!?]$/.test(quote) ||
      protectedRanges.some(
        (r) =>
          (start > r.start && start < r.end) || (end > r.start && end < r.end),
      )
    )
      return [];
    return [{ start, end, quote }];
  });
}
export function plannerClaims(source: string, contract: number, recovery = 1) {
  const paragraphs = researchInputs(source).claims.map((c) => {
    if (contract !== 2) return c;
    let cursor = 0;
    const parts: { quote: string; selectable: boolean }[] = [];
    for (const sentence of factualSentences(c.markdown)) {
      if (sentence.start > cursor)
        parts.push({
          quote: c.markdown.slice(cursor, sentence.start),
          selectable: false,
        });
      parts.push({
        quote: sentence.quote,
        selectable:
          recovery !== 2 || externalClaimCandidate(sentence.quote, c.markdown),
      });
      cursor = sentence.end;
    }
    if (cursor < c.markdown.length)
      parts.push({ quote: c.markdown.slice(cursor), selectable: false });
    return { id: c.id, contextParts: parts };
  });
  return recovery === 2
    ? [
        ...paragraphs,
        ...tableClaims(source).map((c) => ({
          id: c.id,
          contextParts: [{ quote: c.markdown, selectable: true }],
          tableContext: c.tableContext,
        })),
      ]
    : paragraphs;
}
export const FACT_PLAN_SCHEMA = {
  ...PLAN_SCHEMA,
  required: [...PLAN_SCHEMA.required, "targetQuote"],
  properties: { ...PLAN_SCHEMA.properties, targetQuote: { type: "string" } },
};
function exact(value: any, keys: string[]) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((k) => Object.prototype.hasOwnProperty.call(value, k))
  );
}
function position(body: string, quote: any, min: number) {
  if (typeof quote !== "string" || quote.length < min || quote.length > 800)
    throw new Error("seo_research_plan_invalid");
  const start = body.indexOf(quote);
  if (start < 0 || body.indexOf(quote, start + 1) !== -1)
    throw new Error("seo_research_plan_invalid");
  return { start, end: start + quote.length, quote };
}
export function parsePlan(
  value: any,
  source: string,
  hash: string,
  contract = 1,
  recovery = 1,
): ResearchPlan {
  if (
    !exact(value, [
      "verdict",
      "claimId",
      "conditions",
      "anchors",
      "queries",
      ...(contract === 2 ? ["targetQuote"] : []),
    ]) ||
    !["ready", "insufficient"].includes(value.verdict)
  )
    throw new Error("seo_research_plan_invalid");
  if (value.verdict !== "ready") throw new Error("seo_research_insufficient");
  const table =
    recovery === 2
      ? tableClaims(source).find((c) => c.id === value.claimId)
      : undefined;
  const claim =
    table || researchInputs(source).claims.find((c) => c.id === value.claimId);
  if (
    !claim ||
    !Array.isArray(value.conditions) ||
    value.conditions.length < 1 ||
    value.conditions.length > 3 ||
    !Array.isArray(value.anchors) ||
    value.anchors.length < 1 ||
    value.anchors.length > 3 ||
    !Array.isArray(value.queries) ||
    value.queries.length < 1 ||
    value.queries.length > 2
  )
    throw new Error("seo_research_plan_invalid");
  if (
    table &&
    (value.conditions.length !== 1 ||
      value.conditions[0] !== table.tableContext.featureMarkdown ||
      !value.anchors.includes(
        /^\[([^\]]+)\]/.exec(table.tableContext.subjectMarkdown)![1],
      ))
  )
    throw new Error("seo_research_plan_invalid");
  const target =
    table && value.targetQuote === table.markdown
      ? { start: 0, end: table.markdown.length, quote: table.markdown }
      : contract === 2
        ? factualSentences(claim.markdown).find(
            (s) => s.quote === value.targetQuote,
          )
        : undefined;
  if (
    recovery === 2 &&
    (!target ||
      (!table && !externalClaimCandidate(target.quote, claim.markdown)))
  )
    throw new Error("seo_research_plan_invalid");
  if (contract === 2 && !target) throw new Error("seo_research_plan_invalid");
  const canonical = target?.quote || claim.markdown;
  const requiredConditions = value.conditions.map((quote: any) =>
    position(canonical, quote, 12),
  );
  for (const anchor of value.anchors) position(canonical, anchor, 3);
  if (
    new Set(value.conditions).size !== value.conditions.length ||
    new Set(value.anchors).size !== value.anchors.length ||
    new Set(value.queries).size !== value.queries.length
  )
    throw new Error("seo_research_plan_invalid");
  if (
    value.queries.some(
      (query: any) =>
        typeof query !== "string" ||
        query.length < 3 ||
        query.length > 500 ||
        /https?:\/\//i.test(query) ||
        /[\r\n\u0000-\u001f]/u.test(query) ||
        value.anchors.some(
          (anchor: string) =>
            !query.toLowerCase().includes(anchor.toLowerCase()),
        ),
    )
  )
    throw new Error("seo_research_plan_invalid");
  return {
    version: table ? 3 : contract === 2 ? 2 : 1,
    ...(table ? { tableContext: table.tableContext } : {}),
    ...(target ? { target } : {}),
    sourceSha256: hash,
    claimId: claim.id,
    claimMarkdown: claim.markdown,
    requiredConditions,
    anchors: value.anchors,
    queries: value.queries,
  };
}
export function focusedInput(source: string, hash: string, plan: ResearchPlan) {
  const expected = parsePlan(
    {
      verdict: "ready",
      claimId: plan.claimId,
      conditions: plan.requiredConditions.map(({ quote }) => quote),
      anchors: plan.anchors,
      queries: plan.queries,
      ...(plan.version >= 2 ? { targetQuote: plan.target?.quote } : {}),
    },
    source,
    hash,
    plan.version >= 2 ? 2 : 1,
    plan.version === 3 ? 2 : 1,
  );
  if (JSON.stringify(expected) !== JSON.stringify(plan))
    throw new Error("seo_research_plan_mismatch");
  // Complete paragraph: no character truncation or lossy Markdown normalization.
  return { plan, existingUrls: researchInputs(source).existingUrls };
}
export function validatePlannedSearch(result: any, plan: ResearchPlan) {
  const searches = (result.output || []).filter(
    (i: any) => i.type === "web_search_call" && i.action?.type === "search",
  );
  const queries = searches.flatMap(
    (i: any) => i.action.queries || (i.action.query ? [i.action.query] : []),
  );
  if (
    !queries.length ||
    queries.some((q: any) => typeof q !== "string" || !plan.queries.includes(q))
  )
    throw new Error("seo_research_plan_mismatch");
}

export function hasExternalClaimCandidate(source: string) {
  return (
    tableClaims(source).length > 0 ||
    researchInputs(source).claims.some((c) =>
      factualSentences(c.markdown).some((s) =>
        externalClaimCandidate(s.quote, c.markdown),
      ),
    )
  );
}
