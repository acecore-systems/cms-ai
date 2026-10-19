import { describe, expect, it } from "vitest";
import { format } from "prettier";
import { articleBody, portalFormat } from "./fixtures/seo-format.ts";
import {
  acceptEditorialChange,
  assertEditorialFiles,
  assertFormattedSource,
  markdown,
  sourceIdentity,
} from "../src/seo-content.ts";
import { seoArticleUrl, SEO_LOCALES } from "../src/sites.ts";
import { sha256 } from "../src/seo-hash.ts";
const now = Date.parse("2026-10-19T00:00:00Z");
const base =
  "---\ntitle: Original\ndescription: Original description\ndate: 2026-08-08T10:00:00+09:00\nauthor: gui\nimage: /uploads/original.webp\n---\n\nOriginal body [source](https://example.org/guide).\n";

describe("SEO source, locale and copy contracts", () => {
  it("accepts real Prettier GFM table formatting while retaining metadata and content", async () => {
    const original = base + articleBody;
    const formatted = await format(original, portalFormat);
    expect(markdown(original).body.replace(/\s/g, "")).not.toBe(
      markdown(formatted).body.replace(/\s/g, ""),
    );
    expect(() => assertFormattedSource(original, formatted)).not.toThrow();
    expect(() =>
      assertFormattedSource(original, formatted.replaceAll("\n", "\r\n")),
    ).not.toThrow();
  });
  it.each([
    ["table text", "接続方法", "接続先"],
    ["alignment", "| :--- | ---: |", "| ---: | ---: |"],
    ["link", "https://example.org/guide", "https://example.org/other"],
    ["image", "/uploads/story.webp", "/uploads/other.webp"],
    ["metadata", "author: gui", "author: other"],
    ["heading", "## Original", "### Original"],
    ["numbered list start", "1. Original", "3. Original"],
    ["hard break", "確認します。  \n", "確認します。\n"],
    ["paragraph space", "Original 接続環境", "Original接続環境"],
    [
      "paragraph break",
      "First paragraph.\n\nSecond paragraph.",
      "First paragraph.\nSecond paragraph.",
    ],
    ["code whitespace", "server address", "server  address"],
    ["inline code whitespace", "inline code", "inline  code"],
    ["code language", "```text", "```sh"],
    ["HTML", "<!-- note -->", "<!-- other -->"],
    ["task checkbox", "- [ ] Original", "- [x] Original"],
  ])("rejects semantic edits to %s during formatting", (_name, from, to) => {
    const original =
      base +
      articleBody +
      "\n<!-- note -->\n\n- [ ] Original\n\nFirst paragraph.\n\nSecond paragraph.\n";
    const changed = original.replace(from, to);
    expect(changed).not.toBe(original);
    expect(() => assertFormattedSource(original, changed)).toThrow(
      "format_source_changed",
    );
  });
  it("repairs one stray space before a scalar copy field without changing its text", async () => {
    const original = { path: "src/content/blog/example.md", content: base };
    const identity = sourceIdentity(
      "cherry",
      "https://cherry.acecore.net/blog/example/",
      [original],
      now,
    )!;
    const valid = base.replaceAll("Original", "Revised");
    const malformed = valid.replace("\ndescription:", "\n description:");
    expect(() => markdown(malformed)).toThrow("seo_frontmatter");
    const accepted = await acceptEditorialChange(
      identity,
      original,
      { ...original, content: malformed },
      null,
      now,
    );
    const expected = await acceptEditorialChange(
      identity,
      original,
      { ...original, content: valid },
      null,
      now,
    );
    expect(accepted).toBe(expected);
    expect(markdown(accepted).body).toBe(markdown(valid).body);
  });
  it("does not repair ambiguous YAML, immutable fields, duplicate keys or bypass content checks", async () => {
    const original = { path: "src/content/blog/example.md", content: base };
    const identity = sourceIdentity(
      "cherry",
      "https://cherry.acecore.net/blog/example/",
      [original],
      now,
    )!;
    const revised = base.replaceAll("Original", "Revised");
    for (const content of [
      revised.replace("\ndescription:", "\n  description:"),
      revised.replace("\nauthor:", "\n author:"),
      revised
        .replace("\ndescription:", "\n description:")
        .replace("\ndate:", "\ndescription: Duplicate\ndate:"),
      revised
        .replace("title: Revised", "title: |\n  Revised")
        .replace("\ndescription:", "\n description:"),
      revised
        .replace("\ndescription:", "\n description:")
        .replace("\nimage:", "\n image:"),
      revised
        .replace("\ndescription:", "\n description:")
        .replace("https://example.org/guide", "https://invented.test/docs"),
      revised
        .replace("\ndescription:", "\n description:")
        .replace("author: gui", "author: changed"),
    ]) {
      await expect(
        acceptEditorialChange(
          identity,
          original,
          { ...original, content },
          null,
          now,
        ),
      ).rejects.toThrow();
    }
    const block = revised.replace(
      "description: Revised description",
      "description: |\n  Revised description\n  description: literal body text",
    );
    const accepted = await acceptEditorialChange(
      identity,
      original,
      { ...original, content: block },
      null,
      now,
    );
    expect(markdown(accepted).data.description).toBe(
      markdown(block).data.description,
    );
  });
  it("rejects non-article, forged host, query, encoded traversal and non-canonical routes", () => {
    for (const url of [
      "https://asv.acecore.net/en/",
      "https://asv.acecore.net/es/",
      "https://evil.test/stories/example/",
      "https://asv.acecore.net/stories/example/?secret=1",
      "https://asv.acecore.net/stories/a%2Fb/",
      "https://asv.acecore.net/stories/%2e%2e/",
    ])
      expect(seoArticleUrl("portal", url)).toBeNull();
    expect(
      seoArticleUrl("portal", "https://asv.acecore.net/en/stories/example/")
        ?.directory,
    ).toBe("src/content/stories");
    expect(
      seoArticleUrl("hatt", "https://hatt.acecore.net/blog/article/example/")
        ?.slug,
    ).toBe("example");
    expect(
      seoArticleUrl("wiki", "https://asv-wiki.acecore.net/article/遊び方/")
        ?.slug,
    ).toBe("遊び方");
  });
  it("resolves a Hatt public slug independently of its source filename", () => {
    const file = {
      path: "src/content/blog/legacy-file.md",
      content: base.replace("date:", "slug: public-slug\ndate:"),
    };
    expect(
      sourceIdentity(
        "hatt",
        "https://hatt.acecore.net/blog/article/public-slug/",
        [file],
        now,
      )?.articleKey,
    ).toBe("hatt:src/content/blog/legacy-file.md");
  });
  it("keeps corporate articleId immutable while using canonical path as the lock key", () => {
    const content = base.replace(
      "date:",
      "articleId: 11111111-1111-4111-8111-111111111111\ndate:",
    );
    const files = [
      { path: "src/content/blog/example.md", content },
      ...SEO_LOCALES.map((locale) => ({
        path: "src/content/blog/" + locale + "/example.md",
        content,
      })),
    ];
    expect(
      sourceIdentity(
        "corporate",
        "https://acecore.net/en/blog/example/",
        files,
        now,
      )?.articleKey,
    ).toBe("corporate:src/content/blog/example.md");
    expect(
      sourceIdentity(
        "corporate",
        "https://acecore.net/en/blog/example/",
        files.slice(0, -1),
        now,
      ),
    ).toBeNull();
  });
  it("adds the site's supported update field even on a first revision", async () => {
    for (const [site, path, url, field] of [
      [
        "hatt",
        "src/content/blog/example.md",
        "https://hatt.acecore.net/blog/article/example/",
        "lastUpdated",
      ],
      [
        "cherry",
        "src/content/blog/example.md",
        "https://cherry.acecore.net/blog/example/",
        "updatedAt",
      ],
    ]) {
      const original = {
        path,
        content:
          site === "hatt"
            ? base.replace("date:", "slug: example\ndate:")
            : base,
      };
      const identity = sourceIdentity(site, url, [original], now)!;
      const revised = await acceptEditorialChange(
        identity,
        original,
        {
          ...original,
          content: original.content
            .replaceAll("Original", "Revised")
            .replace("\n---\n", "\n" + field + ": 2099-01-01T00:00:00Z\n---\n"),
        },
        null,
        now,
      );
      expect(markdown(revised).data[field]).toBe("2026-10-19T00:00:00Z");
    }
  });
  it("does not invent an update timestamp for Wiki's strict schema", async () => {
    const file = {
      path: "poc/astro-sveltia/src/content/wiki/遊び方.md",
      content:
        "---\ntitle: Original\ndescription: Original\ncategory: guide\norder: 1\n---\n\nOriginal\n",
    };
    const identity = sourceIdentity(
      "wiki",
      "https://asv-wiki.acecore.net/article/遊び方/",
      [file],
      now,
    )!;
    const result = await acceptEditorialChange(
      identity,
      file,
      { ...file, content: file.content.replaceAll("Original", "Revised") },
      null,
      now,
    );
    expect(identity.target.spec.updateField).toBeNull();
    expect(markdown(result).data).not.toHaveProperty("lastUpdated");
    await expect(
      acceptEditorialChange(
        identity,
        file,
        {
          ...file,
          content: file.content
            .replaceAll("Original", "Revised")
            .replace("\n---\n", "\nlastUpdated: 2099-01-01T00:00:00Z\n---\n"),
        },
        null,
        now,
      ),
    ).rejects.toThrow("seo_immutable_metadata");
  });
  it("derives translation timestamps from Japanese, never from a model's timezone conversion", async () => {
    const content = base.replace(
      "\n---\n",
      "\nlastUpdated: 2026-10-09T15:00:00+09:00\n---\n",
    );
    const files = [
      { path: "src/content/stories/example.md", content },
      ...SEO_LOCALES.map((locale) => ({
        path: "src/content/stories/" + locale + "/example.md",
        content: content.replace(
          "description:",
          "translationOf: example\nsourceHash: sha256:" +
            "a".repeat(64) +
            "\ndescription:",
        ),
      })),
    ];
    const identity = sourceIdentity(
      "portal",
      "https://asv.acecore.net/en/stories/example/",
      files,
      now,
    )!;
    const japanese = await acceptEditorialChange(
      identity,
      files[0],
      { ...files[0], content: content.replaceAll("Original", "Revised") },
      null,
      now,
    );
    const original = files[1];
    const revised = original.content.replaceAll("Original", "Translated");
    for (const value of [
      "2026-10-09T15:00:00Z",
      "2099-01-01T00:00:00Z",
      "invalid",
    ]) {
      const proposed = {
        ...original,
        content: revised.replace("2026-10-09T15:00:00+09:00", value),
      };
      const accepted = markdown(
        await acceptEditorialChange(
          identity,
          original,
          proposed,
          japanese,
          now,
        ),
      );
      expect(accepted.data.lastUpdated).toBe(
        markdown(japanese).data.lastUpdated,
      );
      expect(accepted.data.sourceHash).toBe(
        "sha256:" + (await sha256(japanese)),
      );
      expect(accepted.data.date).toBe(markdown(original.content).data.date);
      expect(accepted.body).toBe(markdown(proposed.content).body);
    }
    // Timestamp-only edits cannot masquerade as copy improvements.
    await expect(
      acceptEditorialChange(
        identity,
        original,
        {
          ...original,
          content: original.content.replace(
            "2026-10-09T15:00:00+09:00",
            "2026-10-09T15:00:00Z",
          ),
        },
        japanese,
        now,
      ),
    ).rejects.toThrow("seo_no_copy_change");
    for (const [from, to] of [
      ["2026-08-08T10:00:00+09:00", "2026-08-08T10:00:00Z"],
      ["author: gui", "author: other"],
      ["translationOf: example", "translationOf: other"],
    ]) {
      await expect(
        acceptEditorialChange(
          identity,
          original,
          { ...original, content: revised.replace(from, to) },
          japanese,
          now,
        ),
      ).rejects.toThrow("seo_immutable_metadata");
    }
    for (const trustedSource of [
      japanese.replace("2026-10-19T00:00:00Z", "2099-01-01T00:00:00Z"),
      japanese.replace("2026-10-19T00:00:00Z", "2026-01-01T00:00:00Z"),
    ]) {
      await expect(
        acceptEditorialChange(
          identity,
          original,
          { ...original, content: revised },
          trustedSource,
          now,
        ),
      ).rejects.toThrow("seo_update_date");
    }
  });
  it("rejects protected facts, code, invented references, hash-only or unsafe changes", async () => {
    const original = { path: "src/content/blog/example.md", content: base };
    const identity = sourceIdentity(
      "cherry",
      "https://cherry.acecore.net/blog/example/",
      [original],
      now,
    )!;
    for (const content of [
      base.replace("author: gui", "author: someone"),
      base.replace("image: /uploads/original", "image: /uploads/other"),
      base.replace("2026-08-08", "2026-08-09"),
      base.replace("https://example.org/guide", "https://invented.test/docs"),
      base,
      base.replace("Original body", "<script>bad</script> body"),
      base.replace("Original body", "[bad](javascript:alert(1))"),
      base.replace("Original body", "Original body with 99% improvement"),
    ]) {
      await expect(
        acceptEditorialChange(
          identity,
          original,
          { ...original, content },
          null,
          now,
        ),
      ).rejects.toThrow();
    }
    const code = {
      ...original,
      content: base + "\n```sh\necho original\n```\n",
    };
    await expect(
      acceptEditorialChange(
        identity,
        code,
        {
          ...code,
          content: code.content.replace("echo original", "echo changed"),
        },
        null,
        now,
      ),
    ).rejects.toThrow("seo_code_changed");
  });
  it("requires actual locale copy changes and derives hashes from formatted Japanese text", async () => {
    const sourcePath = "src/content/stories/example.md";
    const files = [
      { path: sourcePath, content: base },
      ...SEO_LOCALES.map((locale) => ({
        path: "src/content/stories/" + locale + "/example.md",
        content: base.replace(
          "date:",
          "translationOf: example\nsourceHash: sha256:" +
            "a".repeat(64) +
            "\ndate:",
        ),
      })),
    ];
    const identity = sourceIdentity(
      "portal",
      "https://asv.acecore.net/en/stories/example/",
      files,
      now,
    )!;
    const japanese = await acceptEditorialChange(
      identity,
      files[0],
      { ...files[0], content: base.replaceAll("Original", "Revised") },
      null,
      now,
    );
    await expect(
      acceptEditorialChange(
        identity,
        files[1],
        {
          ...files[1],
          content: files[1].content.replace("a".repeat(64), "b".repeat(64)),
        },
        japanese,
        now,
      ),
    ).rejects.toThrow("seo_no_copy_change");
    const translated = await acceptEditorialChange(
      identity,
      files[1],
      {
        ...files[1],
        content: files[1].content.replaceAll("Original", "Translated"),
      },
      japanese,
      now,
    );
    expect(markdown(translated).data.sourceHash).toBe(
      "sha256:" + (await sha256(japanese)),
    );
    const full = [
      { path: sourcePath, content: japanese },
      ...files
        .slice(1)
        .map((file) => ({ path: file.path, content: translated })),
    ];
    await expect(
      assertEditorialFiles(identity, files, full),
    ).resolves.toBeUndefined();
    full[1].content = full[1].content.replace("sha256:", "wrong:");
    await expect(assertEditorialFiles(identity, files, full)).rejects.toThrow(
      "seo_translation_hash",
    );
  });
  it("honors the corporate contract without adding a nonexistent sourceHash field", async () => {
    const files = [
      { path: "src/content/blog/example.md", content: base },
      ...SEO_LOCALES.map((locale) => ({
        path: "src/content/blog/" + locale + "/example.md",
        content: base,
      })),
    ];
    const identity = sourceIdentity(
      "corporate",
      "https://acecore.net/blog/example/",
      files,
      now,
    )!;
    const japanese = await acceptEditorialChange(
      identity,
      files[0],
      { ...files[0], content: base.replaceAll("Original", "Revised") },
      null,
      now,
    );
    const translated = await acceptEditorialChange(
      identity,
      files[1],
      { ...files[1], content: base.replaceAll("Original", "Translated") },
      japanese,
      now,
    );
    expect(markdown(translated).data).not.toHaveProperty("sourceHash");
    expect(markdown(translated).data.lastUpdated).toBe(
      markdown(japanese).data.lastUpdated,
    );
  });
});
