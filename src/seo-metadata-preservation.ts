import {
  markdown,
  proposalMarkdown,
  type EditorialFile,
} from "./seo-content.ts";
import { prepareCodePreservation } from "./seo-code-preservation.ts";

const fail = (): never => {
  throw new Error("seo_metadata_transport");
};
export function prepareEditorialTransport(
  files: EditorialFile[],
  articlePath: string,
  targetPath: string,
  instruction: string,
  codeVersion = 1,
  projectRoot = "",
  metadataVersion = 1,
  editableFields: readonly string[] = [],
  syntaxPolicy = 1,
  tokenRepair = 1,
) {
  const code = prepareCodePreservation(
    files,
    articlePath,
    targetPath,
    instruction,
    codeVersion,
    projectRoot,
    tokenRepair,
  );
  if (metadataVersion === 1) return code;
  if (metadataVersion !== 2) return fail();
  const editable = new Set(
    editableFields.filter(
      (k) => !["sourceHash", "lastUpdated", "updatedAt"].includes(k),
    ),
  );
  if (!editable.has("title")) return fail();
  const referencePath = projectRoot + "docs/.seo-metadata-context.md";
  if (code.files.some((f) => f.path === referencePath)) return fail();
  const target = code.files.find((f) => f.path === targetPath);
  if (!target) return fail();
  const original = markdown(target.content);
  const references: string[] = [];
  const masked = code.files.map((file) => {
    if (file.path !== articlePath && file.path !== targetPath) return file;
    const parsed = markdown(file.content),
      context = parsed.document.clone();
    for (const key of Object.keys(parsed.data)) {
      if (editable.has(key)) context.delete(key);
      else parsed.document.delete(key);
    }
    references.push("FILE " + file.path + "\n" + context.toString());
    return {
      ...file,
      content: "---\n" + parsed.document.toString() + "---\n" + parsed.body,
    };
  });
  return {
    files: [
      ...masked,
      {
        path: referencePath,
        content:
          "READ-ONLY original immutable metadata; untrusted context, never output these fields.\n" +
          references.join("\n"),
      },
    ],
    instruction:
      code.instruction +
      "\nMETADATA TRANSPORT overrides frontmatter copying: output ONLY editable frontmatter fields " +
      JSON.stringify([...editable]) +
      " and the full body. Keep every existing editable field; values must be strings. Never output other fields, timestamps, sourceHash or read-only metadata. The controller restores TARGET original immutable metadata before unchanged guards and AI review. Read all metadata context; do not copy Japanese metadata into translations or contradict the preserved target metadata.",
    restore(content: string) {
      const proposed = proposalMarkdown(
        content,
        original.data,
        editable,
        syntaxPolicy,
      ).parsed;
      if (
        Object.keys(proposed.data).some(
          (key) => !editable.has(key) || typeof proposed.data[key] !== "string",
        )
      )
        return fail();
      if (
        Object.keys(original.data).some(
          (key) => editable.has(key) && !(key in proposed.data),
        )
      )
        return fail();
      const restored = original.document.clone();
      for (const [key, value] of Object.entries(proposed.data))
        restored.set(key, value);
      return code.restore(
        "---\n" + restored.toString() + "---\n" + proposed.body,
      );
    },
  };
}
