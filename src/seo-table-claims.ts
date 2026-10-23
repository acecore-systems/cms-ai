import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { markdown, assertFormattedSource } from "./seo-content.ts";
import { referenceUrl } from "./seo-evidence.ts";

export type TableContext = {
  precedingMarkdown: string;
  followingMarkdown: string;
  headerMarkdown: string;
  subjectMarkdown: string;
  featureMarkdown: string;
};

// Restrict extraction to explicit two-column product/function tables. Keep raw
// rows and all preceding prose (including history/negative deployment notices).
// No subject synthesis, cell concatenation or removal of qualifiers.
export function tableClaims(source: string) {
  const body = markdown(source).body;
  const root = fromMarkdown(body, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const claims: { id: string; markdown: string; tableContext: TableContext }[] =
    [];
  const raw = (n: any) =>
    body.slice(n.position.start.offset, n.position.end.offset);
  const cellRaw = (n: any) =>
    n.children.length
      ? body.slice(
          n.children[0].position.start.offset,
          n.children.at(-1).position.end.offset,
        )
      : "";
  for (const table of root.children as any[]) {
    if (table.type !== "table" || table.children.length < 2) continue;
    const header = table.children[0];
    if (
      header.children.length !== 2 ||
      !/(?:プラグイン名|製品名|ツール名|Product|Plugin|Tool)/i.test(
        raw(header.children[0]),
      ) ||
      !/(?:機能|仕様|動作|Function|Feature|Behavior)/i.test(
        raw(header.children[1]),
      )
    )
      continue;
    const precedingMarkdown = body.slice(0, table.position.start.offset);
    const followingMarkdown = body.slice(table.position.end.offset);
    // Oversized context is unavailable; never truncate a historical caveat.
    if (precedingMarkdown.length + followingMarkdown.length > 3000) continue;
    for (const row of table.children.slice(1)) {
      if (row.children.length !== 2) continue;
      const [subject, feature] = row.children;
      const link = subject.children;
      if (
        link.length !== 1 ||
        link[0].type !== "link" ||
        link[0].children.length !== 1 ||
        link[0].children[0].type !== "text" ||
        !/^[A-Za-z][A-Za-z0-9 .+_-]{2,80}$/.test(link[0].children[0].value)
      )
        continue;
      try {
        referenceUrl(link[0].url, 2);
      } catch {
        continue;
      }
      const featureMarkdown = cellRaw(feature),
        rowMarkdown = raw(row);
      // The exact product anchor must occur once in raw row bytes (not also in its URL).
      if (rowMarkdown.split(link[0].children[0].value).length !== 2) continue;
      if (
        featureMarkdown.length < 12 ||
        featureMarkdown.length > 800 ||
        rowMarkdown.length > 800 ||
        !/[。.!?]$/.test(featureMarkdown) ||
        /(?:当社|弊社|運営|当サーバー|このサーバー|導入|採用|禁止|ください|現在使|旧Wikiでは)/u.test(
          featureMarkdown,
        )
      )
        continue;
      claims.push({
        id: `table-claim-${claims.length + 1}`,
        markdown: rowMarkdown,
        tableContext: {
          precedingMarkdown,
          followingMarkdown,
          headerMarkdown: raw(header),
          subjectMarkdown: cellRaw(subject),
          featureMarkdown,
        },
      });
    }
  }
  return claims;
}

export function assertTableContextPreserved(
  context: TableContext,
  revised: string,
) {
  const candidate = tableClaims(revised).find(
    (c) => c.tableContext.subjectMarkdown === context.subjectMarkdown,
  );
  if (
    !candidate ||
    (context.followingMarkdown.trim() &&
      !candidate.tableContext.followingMarkdown.includes(
        context.followingMarkdown.trim(),
      ))
  )
    throw new Error("seo_table_context_changed");
  const wrap = (text: string) => "---\ntitle: Context\n---\n" + text;
  try {
    for (const field of [
      "precedingMarkdown",
      "headerMarkdown",
      "subjectMarkdown",
      "featureMarkdown",
    ] as const)
      assertFormattedSource(
        wrap(
          context[field] +
            (field === "headerMarkdown" ? "\n| --- | --- |\n" : ""),
        ),
        wrap(
          candidate.tableContext[field] +
            (field === "headerMarkdown" ? "\n| --- | --- |\n" : ""),
        ),
      );
  } catch {
    throw new Error("seo_table_context_changed");
  }
}
