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
  version: 1;
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
): ResearchPlan {
  if (
    !exact(value, ["verdict", "claimId", "conditions", "anchors", "queries"]) ||
    !["ready", "insufficient"].includes(value.verdict)
  )
    throw new Error("seo_research_plan_invalid");
  if (value.verdict !== "ready") throw new Error("seo_research_insufficient");
  const claim = researchInputs(source).claims.find(
    (c) => c.id === value.claimId,
  );
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
  const requiredConditions = value.conditions.map((quote: any) =>
    position(claim.markdown, quote, 12),
  );
  for (const anchor of value.anchors) position(claim.markdown, anchor, 3);
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
    version: 1,
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
    },
    source,
    hash,
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
