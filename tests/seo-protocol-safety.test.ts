import { it, expect } from "vitest";
import { unsafeEditorialProtocol } from "../src/seo-protocol-safety.ts";
const header = "---\ntitle: Test\n---\n";
it.each([
  "JavaScript : mesurez le volume.",
  "JavaScript\u00a0: mesurez.",
  "JavaScript\u202f: mesurez.",
  "## JavaScript : mesurez",
  "| Langage | Note |\n| --- | --- |\n| JavaScript : mesurez | Texte |",
  "[JavaScript : mesurez](https://example.org)",
])("accepts rendered prose %s", (body) => {
  expect(unsafeEditorialProtocol(header + body, body)).toBe(false);
});
it.each([
  "javascript:alert(1)",
  "[x](javascript:alert%281%29)",
  "[x](javascript&#58;alert)",
  "[x](java&#x09;script:alert)",
  "[x](<javascript : alert>)",
  "![x](data:text/plain,x)",
  "[x][ref]\n\n[ref]: javascript:alert",
  '<a href="javascript : alert(1)">x</a>',
  "`javascript : alert(1)`",
  "```js\njavascript : alert(1)\n```",
  "file:/private",
  "vbscript:msgbox(1)",
  "data:text/html,x",
  "JavaScript\n: alert(1)",
])("rejects executable destinations or non-prose %s", (body) => {
  expect(unsafeEditorialProtocol(header + body, body)).toBe(true);
});
it("does not exempt frontmatter and still inspects decoded URLs beside prose", () => {
  const body = "JavaScript : texte.";
  expect(
    unsafeEditorialProtocol(
      "---\ntitle: 'JavaScript : texte'\n---\n" + body,
      body,
    ),
  ).toBe(true);
  expect(
    unsafeEditorialProtocol(
      header + body + " [x](javascript&#58;alert)",
      body + " [x](javascript&#58;alert)",
    ),
  ).toBe(true);
});
