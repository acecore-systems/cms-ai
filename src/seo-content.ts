import { parseDocument } from "yaml";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { seoArticleUrl } from "./sites.ts";
import { sha256 } from "./seo-hash.ts";

export type EditorialFile = { path: string; content: string };
export const normalizeLf = (text: string) => text.replace(/\r\n?/g, "\n");
export function markdown(text: string) {
  const normalized = normalizeLf(text);
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) throw new Error("seo_frontmatter");
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length) throw new Error("seo_frontmatter");
  const data = document.toJS({ maxAliasCount: 0 });
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    typeof data.title !== "string" ||
    !data.title.trim()
  )
    throw new Error("seo_frontmatter");
  return {
    document,
    data: data as Record<string, unknown>,
    body: normalized.slice(match[0].length),
  };
}

// Formatting can change GFM table delimiters, escapes and emphasis markers.
// Compare parsed content, dropping only source coordinates: text whitespace,
// hard breaks, table alignment, URLs, HTML and code values remain significant.
// Unrecognised dialect syntax is retained as text and fails closed if changed.
export function assertFormattedSource(original: string, formatted: string) {
  const before = markdown(original),
    after = markdown(formatted);
  const tree = (body: string) =>
    JSON.stringify(
      fromMarkdown(body, {
        extensions: [gfm()],
        mdastExtensions: [gfmFromMarkdown()],
      }),
      (key, value) => (key === "position" ? undefined : value),
    );
  if (
    JSON.stringify(before.data) !== JSON.stringify(after.data) ||
    tree(before.body) !== tree(after.body)
  )
    throw new Error("format_source_changed");
}

export function sourceIdentity(
  siteId: string,
  url: string,
  files: EditorialFile[],
  now = Date.now(),
) {
  const target = seoArticleUrl(siteId, url);
  if (!target) return null;
  const matches = files.filter((file) => {
    if (
      !file.path.startsWith(target.directory + "/") ||
      file.path.slice(target.directory.length + 1).includes("/") ||
      !file.path.endsWith(".md")
    )
      return false;
    const { data } = markdown(file.content);
    const slug = target.spec.slugField
      ? data[target.spec.slugField]
      : file.path.slice(target.directory.length + 1, -3);
    return slug === target.slug;
  });
  if (matches.length !== 1) return null;
  const source = matches[0];
  const { data } = markdown(source.content);
  if (data.draft === true) return null;
  if (target.spec.key !== "wiki") {
    if (
      typeof data.date !== "string" ||
      !Number.isFinite(Date.parse(data.date)) ||
      Date.parse(data.date) > now
    )
      return null;
  }
  if (
    data.articleId !== undefined &&
    (typeof data.articleId !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(data.articleId))
  )
    throw new Error("seo_article_id");
  const filename = source.path.slice(target.directory.length + 1);
  const translations = (target.spec.locales as readonly string[]).map(
    (locale) => ({
      locale,
      path: target.directory + "/" + locale + "/" + filename,
    }),
  );
  if (!translations.every((t) => files.some((f) => f.path === t.path)))
    return null;
  return {
    target,
    source,
    translations,
    articleKey: target.spec.key + ":" + source.path,
  };
}
export type ArticleIdentity = NonNullable<ReturnType<typeof sourceIdentity>>;

function externalUrls(text: string) {
  return new Set(
    [...text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/gu)].map((match) => match[0]),
  );
}
function codeBlocks(text: string) {
  return [
    ...text.matchAll(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g),
  ].map((match) => match[0].trim());
}
function assertContent(original: string, next: string) {
  if (/\b(?:javascript|vbscript|file|data)\s*:/iu.test(next))
    throw new Error("seo_content_unsafe");
  if (
    BufferlessBytes(next) > 128 * 1024 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(
      next,
    )
  )
    throw new Error("seo_content_unsafe");
  const originalUrls = externalUrls(original);
  if ([...externalUrls(next)].some((url) => !originalUrls.has(url)))
    throw new Error("seo_unverified_reference");
  if (JSON.stringify(codeBlocks(original)) !== JSON.stringify(codeBlocks(next)))
    throw new Error("seo_code_changed");
  const originalNumbers = new Set(
    markdown(original).body.match(/\d+(?:[.,]\d+)*(?:[%％])?/g) || [],
  );
  if (
    (markdown(next).body.match(/\d+(?:[.,]\d+)*(?:[%％])?/g) || []).some(
      (number) => !originalNumbers.has(number),
    )
  )
    throw new Error("seo_number_added");
  const rawHtml = /<\/?[A-Za-z][^>]*>|<!--/gu;
  if (
    JSON.stringify(original.match(rawHtml)) !==
    JSON.stringify(next.match(rawHtml))
  )
    throw new Error("seo_html_changed");
}
function BufferlessBytes(text: string) {
  return new TextEncoder().encode(text).length;
}

// Repair only an invalid mapping caused by one extra space before a copy field.
// Each adjacent line must independently be a complete, existing string field;
// block/flow values, nested structures, aliases and valid YAML are never repaired.
function proposalMarkdown(
  content: string,
  original: Record<string, unknown>,
  editable: Set<string>,
) {
  try {
    return { content, parsed: markdown(content) };
  } catch {
    const match = /^(---\n)([\s\S]*?)(\n---(?:\n|$))([\s\S]*)$/.exec(
      normalizeLf(content),
    );
    if (!match) throw new Error("seo_frontmatter");
    const lines = match[2].split("\n");
    const scalar = (line: string) => {
      const field = /^([A-Za-z][A-Za-z0-9]*): [^\s|>!&*[{]/.exec(line)?.[1];
      if (!field || typeof original[field] !== "string") return null;
      try {
        const document = parseDocument(line, { uniqueKeys: true });
        if (document.errors.length) return null;
        const value = document.toJS({ maxAliasCount: 0 });
        return Object.keys(value).length === 1 &&
          typeof value[field] === "string"
          ? field
          : null;
      } catch {
        return null;
      }
    };
    const repairs: number[] = [];
    for (let i = 1; i < lines.length; i++) {
      if (!/^ [A-Za-z][A-Za-z0-9]*: /.test(lines[i])) continue;
      const field = scalar(lines[i].slice(1));
      if (
        field &&
        editable.has(field) &&
        scalar(lines[i - 1]) &&
        (i === lines.length - 1 || /^[A-Za-z][A-Za-z0-9]*:/.test(lines[i + 1]))
      )
        repairs.push(i);
    }
    // Multiple ambiguous errors need review, not a best-effort YAML rewrite.
    if (repairs.length !== 1) throw new Error("seo_frontmatter");
    lines[repairs[0]] = lines[repairs[0]].slice(1);
    const repaired = match[1] + lines.join("\n") + match[3] + match[4];
    return { content: repaired, parsed: markdown(repaired) };
  }
}

// Model text can edit copy only. Immutable metadata and sourceHash are controlled here.
export async function acceptEditorialChange(
  identity: ArticleIdentity,
  original: EditorialFile,
  proposed: EditorialFile,
  japanese: string | null,
  now = Date.now(),
) {
  if (original.path !== proposed.path || !proposed.content.trim())
    throw new Error("seo_change_path");
  const before = markdown(original.content);
  const editable = new Set<string>(identity.target.spec.editableFields);
  editable.delete("lastUpdated");
  editable.delete("updatedAt");
  if (japanese && identity.target.spec.translationHash === "frontmatter")
    editable.add("sourceHash");
  const normalized = proposalMarkdown(proposed.content, before.data, editable);
  const after = normalized.parsed;
  const dateField = identity.target.spec.updateField;
  // The model does not own the site's update timestamp. Restore its original
  // value before metadata/copy checks, then derive the accepted timestamp below
  // from the controller clock or accepted Japanese source. Never trust a model
  // timezone conversion; all other immutable fields still compare unchanged.
  if (dateField) {
    if (before.data[dateField] === undefined) {
      after.document.delete(dateField);
      delete after.data[dateField];
    } else {
      after.document.set(dateField, before.data[dateField]);
      after.data[dateField] = before.data[dateField];
    }
  }
  for (const key of new Set([
    ...Object.keys(before.data),
    ...Object.keys(after.data),
  ])) {
    if (
      !editable.has(key) &&
      JSON.stringify(before.data[key]) !== JSON.stringify(after.data[key])
    )
      throw new Error("seo_immutable_metadata");
  }
  const originalComparable = { ...before.data };
  const afterComparable = { ...after.data };
  delete originalComparable.sourceHash;
  delete afterComparable.sourceHash;
  if (
    JSON.stringify(originalComparable) === JSON.stringify(afterComparable) &&
    before.body.trim() === after.body.trim()
  )
    throw new Error("seo_no_copy_change");
  assertContent(original.content, normalized.content);
  if (japanese && identity.target.spec.translationHash === "frontmatter") {
    const expected = "sha256:" + (await sha256(normalizeLf(japanese)));
    if (before.data.sourceHash !== undefined)
      after.document.set("sourceHash", expected);
    // Systems uses a separate translation-state contract instead of per-file hashes.
    else throw new Error("seo_translation_hash_missing");
  }
  if (dateField) {
    const previous =
      before.data[dateField] === undefined
        ? -Infinity
        : Date.parse(String(before.data[dateField]));
    const timestamp = japanese
      ? String(markdown(japanese).data[dateField])
      : new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
    if (
      Number.isNaN(previous) ||
      Date.parse(timestamp) <= previous ||
      Date.parse(timestamp) > now
    )
      throw new Error("seo_update_date");
    after.document.set(dateField, timestamp);
  }
  return "---\n" + String(after.document).trimEnd() + "\n---\n" + after.body;
}

export async function assertEditorialFiles(
  identity: ArticleIdentity,
  originals: EditorialFile[],
  files: EditorialFile[],
) {
  const japanese = files.find((f) => f.path === identity.source.path)!;
  if (!japanese) throw new Error("seo_source_missing");
  const sourceHash = "sha256:" + (await sha256(normalizeLf(japanese.content)));
  for (const path of [
    identity.source.path,
    ...identity.translations.map((t) => t.path),
  ]) {
    const original = originals.find((f) => f.path === path),
      revised = files.find((f) => f.path === path);
    if (!original || !revised) throw new Error("seo_locale_missing");
    const before = markdown(original.content),
      after = markdown(revised.content);
    const fields = new Set<string>(identity.target.spec.editableFields);
    if (identity.target.spec.updateField)
      fields.add(identity.target.spec.updateField);
    if (
      path !== identity.source.path &&
      identity.target.spec.translationHash === "frontmatter"
    )
      fields.add("sourceHash");
    for (const key of new Set([
      ...Object.keys(before.data),
      ...Object.keys(after.data),
    ])) {
      if (
        !fields.has(key) &&
        JSON.stringify(before.data[key]) !== JSON.stringify(after.data[key])
      )
        throw new Error("seo_immutable_metadata");
    }
    if (
      path !== identity.source.path &&
      identity.target.spec.translationHash === "frontmatter" &&
      after.data.sourceHash !== sourceHash
    )
      throw new Error("seo_translation_hash");
    const dateField = identity.target.spec.updateField;
    if (
      dateField &&
      (typeof after.data[dateField] !== "string" ||
        !Number.isFinite(Date.parse(after.data[dateField] as string)) ||
        (before.data[dateField] !== undefined &&
          Date.parse(after.data[dateField] as string) <=
            Date.parse(String(before.data[dateField]))) ||
        (path !== identity.source.path &&
          after.data[dateField] !== markdown(japanese.content).data[dateField]))
    )
      throw new Error("seo_update_date");
    const previous = { ...before.data },
      next = { ...after.data };
    for (const key of ["sourceHash", "lastUpdated", "updatedAt"]) {
      delete previous[key];
      delete next[key];
    }
    if (
      JSON.stringify(previous) === JSON.stringify(next) &&
      before.body.trim() === after.body.trim()
    )
      throw new Error("seo_no_copy_change");
    assertContent(original.content, revised.content);
  }
}
