import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

const protocol = /\b(?:javascript|vbscript|file|data)\s*:/giu;

// Only whitespace-delimited punctuation in a rendered text node is prose.
// Destinations (including decoded references/entities), HTML, code and YAML
// remain outside that exception. Never rewrite or relax an executable URL.
export function unsafeEditorialProtocol(
  content: string,
  body: string,
): boolean {
  const offset = content.length - body.length;
  const textRanges: [number, number][] = [];
  let unsafeUrl = false;
  const visit = (node: any) => {
    if (
      typeof node.url === "string" &&
      /^(?:javascript|vbscript|file|data):/iu.test(
        node.url.replace(/[\s\u0000-\u001f\u007f]/gu, ""),
      )
    )
      unsafeUrl = true;
    if (
      node.type === "text" &&
      Number.isInteger(node.position?.start?.offset) &&
      Number.isInteger(node.position?.end?.offset)
    )
      textRanges.push([
        offset + node.position.start.offset,
        offset + node.position.end.offset,
      ]);
    for (const child of node.children ?? []) visit(child);
  };
  visit(
    fromMarkdown(body, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }),
  );
  if (unsafeUrl) return true;
  for (const match of content.matchAll(protocol)) {
    const end = match.index + match[0].length;
    if (
      !/[ \u00a0\u202f]+:$/u.test(match[0]) ||
      !/[ \u00a0\u202f]/u.test(content[end] ?? "") ||
      !textRanges.some(([start, stop]) => start <= match.index && end < stop)
    )
      return true;
  }
  return false;
}
