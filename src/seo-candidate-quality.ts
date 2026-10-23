import { fromMarkdown } from "mdast-util-from-markdown";
import { plannerClaims } from "./seo-research-plan.ts";

// New collection only. Do not change the persisted planner/receipt contracts.
// A product-looking subject is not evidence of a product specification: the
// predicate may instead describe a person's work or this site's implementation.
export function hasResearchableCandidate(source: string) {
  return plannerClaims(source, 2, 2).some((claim) => {
    if (!("contextParts" in claim)) return false;
    if ("tableContext" in claim) return true; // Existing exact table contract.
    return claim.contextParts.some((part) => {
      if (!part.selectable) return false;
      const text = plain(part.quote);
      return !(
        /^AI(?:は|では|には).*(?:走査|読み込み|直接操作|検証します)/u.test(
          text,
        ) ||
        /(?:の活動|創作活動|制作活動|事業活動|活動を行|制作を行|制作しています|取り組んで|手がけ|手掛け|ホームページは|プロフィール|制作事例|制作実績|代替しました|確保しました|実現しました|できるようにしました)/u.test(
          text,
        ) ||
        /(?:採用|導入|構築|実装|利用|使用|運用|接続|追加|公開)(?:しました|しています|している|しており|した)|組み込(?:みました|んでいます)|使って(?:います|いる|おり)/u.test(
          text,
        ) ||
        (/\b(?:adopted|implemented|deployed|launched|integrated|built|installed)\b/i.test(
          text,
        ) &&
          /\b(?:this|our|the|my) (?:site|website|portfolio|project|server|application)\b/i.test(
            text,
          ))
      );
    });
  });
}
function plain(markdown: string): string {
  const visit = (node: any): string =>
    node.type === "text" || node.type === "inlineCode"
      ? node.value
      : (node.children || []).map(visit).join("");
  return visit(fromMarkdown(markdown));
}
