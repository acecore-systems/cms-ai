import { expect, it } from "vitest";
import { acceptEditorialChange, sourceIdentity } from "../src/seo-content.ts";

const now = Date.parse("2026-10-24T14:00:00Z");
const base =
  "---\ntitle: Original\ndescription: Original description\ndate: 2026-08-08T10:00:00+09:00\nauthor: gui\nimage: /uploads/original.webp\n---\n\nOriginal body.\n";
function accept(body: string, original = base) {
  const source = { path: "src/content/blog/example.md", content: original };
  const identity = sourceIdentity(
    "cherry",
    "https://cherry.acecore.net/blog/example/",
    [source],
    now,
  )!;
  return acceptEditorialChange(
    identity,
    source,
    { ...source, content: body },
    null,
    now,
  );
}
it.each([
  "`[env.<name>]`",
  "``[env.<name>] with ` literal``",
  "`<name>\nplaceholder`",
  "**`<name>`**",
  "- `<name>`",
  "| setting |\n| --- |\n| `<name>` |",
  "`<script>not executed</script>`",
])("accepts parser-confirmed literal code: %s", async (code) => {
  await expect(accept(base + "\n" + code + "\n")).resolves.toContain(code);
});
it.each([
  "<span>new HTML</span>",
  "`<span>unclosed code",
  "``<span>mismatched`",
  "\\`<span>`",
  "<script>alert()</script>",
  "<!-- new comment -->",
  "`safe` <span>outside code</span>",
  "<a title='`<span>`'>text</a>",
  "<div>\n`<span>`\n</div>",
])("still rejects real HTML and ambiguous code: %s", async (html) => {
  await expect(accept(base + "\n" + html + "\n")).rejects.toThrow(
    "seo_html_changed",
  );
});
it("keeps frontmatter outside code-span masking", async () => {
  await expect(
    accept(base.replace("title: Original", "title: Revised `<span>`")),
  ).rejects.toThrow("seo_html_changed");
});
it("does not turn existing HTML into code or change attributes/order", async () => {
  const original = base + '\n<span class="old">text</span>\n';
  for (const changed of [
    original.replace('class="old"', 'class="new"'),
    original.replace(
      '<span class="old">text</span>',
      '`<span class="old">text</span>`',
    ),
  ])
    await expect(accept(changed, original)).rejects.toThrow("seo_html_changed");
  await expect(
    accept(
      original.replace("Original body", "Revised body") + "\n`[env.<name>]`\n",
      original,
    ),
  ).resolves.toContain('class="old"');
});
it("keeps fenced code, numeric and unsafe scheme guards", async () => {
  const original = base + "\n```html\n<span>original</span>\n```\n";
  await expect(
    accept(original.replace("original</span>", "changed</span>"), original),
  ).rejects.toThrow("seo_code_changed");
  await expect(accept(base + "\n`<name99>`\n")).rejects.toThrow(
    "seo_number_added",
  );
  await expect(accept(base + "\n`javascript:alert()`\n")).rejects.toThrow(
    "seo_content_unsafe",
  );
});
