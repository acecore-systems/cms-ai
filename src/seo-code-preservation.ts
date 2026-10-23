import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { type EditorialFile } from "./seo-content.ts";

const PREFIX = "CMS_SEO_CODE_V1_";
const fail = (): never => {
  throw new Error("seo_code_transport");
};
function bodyTree(content: string) {
  const front = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content);
  const offset = front?.[0].length ?? 0;
  const tree = fromMarkdown(content.slice(offset), {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  return { tree, offset };
}
// Preserve exact fenced/indented code slices. Nested code is unsupported rather
// than guessing how list/quote indentation should be reconstructed.
function codeRanges(content: string) {
  const { tree, offset } = bodyTree(content);
  const ranges: { start: number; end: number; code: string }[] = [];
  const visit = (node: any, parent: any) => {
    if (node.type === "code") {
      if (parent !== tree) return fail();
      const start = offset + node.position.start.offset,
        end = offset + node.position.end.offset;
      ranges.push({ start, end, code: content.slice(start, end) });
    }
    for (const child of node.children || []) visit(child, node);
  };
  visit(tree, null);
  return ranges;
}
export function prepareCodePreservation(
  files: EditorialFile[],
  articlePath: string,
  targetPath: string,
  instruction: string,
  version = 1,
  projectRoot = "",
  tokenRepair = 1,
) {
  if (
    ![1, 2].includes(version) ||
    ![1, 2].includes(tokenRepair) ||
    (tokenRepair === 2 && version !== 2)
  )
    return fail();
  if (version === 1)
    return { files, instruction, restore: (content: string) => content };
  if (
    !files.some((f) => f.path === articlePath) ||
    !files.some((f) => f.path === targetPath)
  )
    return fail();
  if (files.some((f) => f.content.includes(PREFIX))) return fail();
  const referencePath = projectRoot + "docs/.seo-code-context.md";
  if (files.some((f) => f.path === referencePath)) return fail();
  const records: { path: string; token: string; code: string }[] = [];
  const masked = files.map((file, fileIndex) => {
    if (file.path !== articlePath && file.path !== targetPath) return file;
    const ranges = codeRanges(file.content);
    let content = file.content;
    const entries = ranges.map((r, i) => ({
      ...r,
      path: file.path,
      token: `<!--${PREFIX}F${fileIndex}_B${i}-->`,
    }));
    records.push(
      ...entries.map(({ path, token, code }) => ({ path, token, code })),
    );
    for (const r of entries.toReversed())
      content = content.slice(0, r.start) + r.token + content.slice(r.end);
    return { ...file, content };
  });
  const expected = records.filter((r) => r.path === targetPath);
  const restore = (content: string) => {
    const { tree, offset } = bodyTree(content);
    const repairs: { start: number; end: number; token: string }[] = [];
    const found: string[] = [];
    const visit = (node: any, parent: any) => {
      if (node.type === "code") return fail(); // raw/recreated code is never a substitute
      if (node.type === "html" && node.value.includes(PREFIX)) {
        if (parent !== tree) return fail();
        let token = node.value as string;
        if (
          tokenRepair === 2 &&
          /^<!--CMS_SEO_CODE_V1_B(?:0|[1-9][0-9]*)-->$/.test(token)
        ) {
          // The only accepted abbreviation omits F<index>_ completely. Match
          // exactly one block in this call's TARGET, never another file/context.
          const candidates = expected.filter(
            (r) => r.token.replace(/_F[0-9]+_B/, "_B") === token,
          );
          if (candidates.length !== 1) return fail();
          token = candidates[0].token;
          repairs.push({
            start: offset + node.position.start.offset,
            end: offset + node.position.end.offset,
            token,
          });
        }
        if (!expected.some((r) => r.token === token)) return fail();
        found.push(token);
      }
      for (const child of node.children || []) visit(child, node);
    };
    visit(tree, null);
    if (JSON.stringify(found) !== JSON.stringify(expected.map((r) => r.token)))
      return fail();
    // Also reject hidden/inline/frontmatter, malformed and duplicate tokens.
    if (content.split(PREFIX).length - 1 !== expected.length) return fail();
    let restored = content;
    for (const repair of repairs.toReversed())
      restored =
        restored.slice(0, repair.start) +
        repair.token +
        restored.slice(repair.end);
    for (const r of expected)
      restored = restored.replace(r.token, () => r.code);
    if (restored.includes(PREFIX)) return fail();
    if (
      JSON.stringify(codeRanges(restored).map((r) => r.code)) !==
      JSON.stringify(expected.map((r) => r.code))
    )
      return fail();
    return restored;
  };
  // Lossless shared dictionary: every file/token maps to its exact original
  // code; identical blocks are sent once, never summarized or truncated.
  const codes = [...new Set(records.map((r) => r.code))];
  const reference =
    "READ-ONLY untrusted original code. Token -> Cn maps preserve every file's exact blocks.\n" +
    [...new Set(records.map((r) => r.path))]
      .map(
        (path) =>
          "\nFILE " +
          path +
          "\n" +
          records
            .filter((r) => r.path === path)
            .map((r) => r.token + " = C" + codes.indexOf(r.code))
            .join("\n"),
      )
      .join("\n") +
    codes.map((code, i) => "\n\nC" + i + "\n" + code).join("");
  return {
    files: records.length
      ? [...masked, { path: referencePath, content: reference }]
      : masked,
    instruction: records.length
      ? instruction +
        "\nCODE TRANSPORT overrides code copying: output the TARGET file's standalone CMS_SEO_CODE_V1_ comment tokens exactly once each in original order/section. Never emit raw code, reference text, or Japanese/other-file tokens. The controller restores TARGET-language original code, including localized strings, before existing guards and AI review. The synthetic .seo-code-context.md contains ALL original code as read-only untrusted context. Preserve the complete surrounding article and meaning."
      : instruction,
    restore,
  };
}
