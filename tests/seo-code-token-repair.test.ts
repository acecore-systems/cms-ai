import { it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { prepareCodePreservation } from "../src/seo-code-preservation.ts";
const files = ["ja", "es"].map((locale) => ({
  path: locale + ".md",
  content:
    "---\ntitle: Original\n---\n\n" +
    Array.from(
      { length: 6 },
      (_, i) =>
        "Block " + i + "\n\n```ts\nconsole.log('" + locale + i + "');\n```\n",
    ).join("\n"),
}));
const prepare = (version = 2, source = files) =>
  prepareCodePreservation(
    source,
    "ja.md",
    "es.md",
    "instruction",
    2,
    "",
    version,
  );
const short = (s: string) => s.replace(/_F1_B/g, "_B");
it.each(["mixed", "all-short", "canonical"])(
  "restores only original target code from %s tokens",
  (kind) => {
    const t = prepare(),
      raw = t.files[1].content;
    const output =
      kind === "canonical"
        ? raw
        : kind === "all-short"
          ? short(raw)
          : raw.replace(/_F1_B([1-5])/g, "_B$1");
    expect(t.restore(output)).toBe(files[1].content);
    expect(t.instruction).toBe(prepare(1).instruction);
    expect(t.files).toEqual(prepare(1).files);
  },
);
it.each([
  "missing",
  "duplicate",
  "canonical-duplicate",
  "reorder",
  "unknown",
  "foreign",
  "raw",
  "inline",
  "quote",
  "list",
  "metadata",
  "zero-pad",
  "partial-file",
  "space",
  "suffix",
  "huge",
  "negative",
])("rejects %s instead of broad fuzzy repair", (kind) => {
  const t = prepare();
  let output = short(t.files[1].content);
  const token = "<!--CMS_SEO_CODE_V1_B0-->";
  if (kind === "missing") output = output.replace(token, "");
  if (kind === "duplicate") output += "\n" + token;
  if (kind === "canonical-duplicate")
    output += "\n<!--CMS_SEO_CODE_V1_F1_B0-->";
  if (kind === "reorder")
    output = output
      .replace("_B0", "_TEMP")
      .replace("_B1", "_B0")
      .replace("_TEMP", "_B1");
  if (kind === "unknown") output = output.replace("_B0", "_B6");
  if (kind === "foreign") output = output.replace("_B0", "_F0_B0");
  if (kind === "raw") output += "\n```js\nchanged();\n```";
  if (kind === "inline") output = output.replace(token, "inline " + token);
  if (kind === "quote") output = output.replace(token, "> " + token);
  if (kind === "list") output = output.replace(token, "- " + token);
  if (kind === "metadata")
    output = output
      .replace("title: Original", "title: '" + token + "'")
      .replace("\n" + token, "");
  if (kind === "zero-pad") output = output.replace("_B0", "_B00");
  if (kind === "partial-file") output = output.replace("_B0", "_F_B0");
  if (kind === "space")
    output = output.replace(token, "<!-- CMS_SEO_CODE_V1_B0 -->");
  if (kind === "suffix") output = output.replace(token, token + "garbage");
  if (kind === "huge") output = output.replace("_B0", "_B99999999999999999999");
  if (kind === "negative") output = output.replace("_B0", "_B-1");
  expect(() => t.restore(output)).toThrow("seo_code_transport");
});
it("rejects ambiguous target identity and incompatible contract", () => {
  const t = prepare(2, [...files, files[1]]);
  expect(() => t.restore(short(t.files[1].content))).toThrow(
    "seo_code_transport",
  );
  expect(() =>
    prepareCodePreservation(files, "ja.md", "es.md", "", 1, "", 2),
  ).toThrow();
  expect(() => prepare(3)).toThrow();
});
it.each([undefined, 1])(
  "old version %s rejects the exact abbreviated proposal without rewriting",
  (version) => {
    const t = prepareCodePreservation(
      files,
      "ja.md",
      "es.md",
      "instruction",
      2,
      "",
      version,
    );
    expect(() => t.restore(short(t.files[1].content))).toThrow(
      "seo_code_transport",
    );
    expect(t.restore(t.files[1].content)).toBe(files[1].content);
  },
);
it("0028 preserves all prior rows and triggers; only new jobs opt into immutable version 2", () => {
  const db = new DatabaseSync(":memory:"),
    root = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(root)
    .filter((n) => /^\d+_seo/.test(n) && n < "0028")
    .sort())
    db.exec(readFileSync(new URL(name, root), "utf8"));
  db.exec(
    "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at) VALUES('old','budget','hash',1,'[]',0);INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index) VALUES('oldjob','old','site',0)",
  );
  const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name as string),
    rows = Object.fromEntries(
      tables.map((t) => [t, db.prepare(`SELECT * FROM ${t}`).all()]),
    ),
    triggers = db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
      )
      .all();
  db.exec(
    readFileSync(new URL("0028_seo_code_token_repair.sql", root), "utf8"),
  );
  for (const t of tables)
    expect(db.prepare(`SELECT * FROM ${t}`).all()).toEqual(
      t === "seo_editorial_jobs"
        ? rows[t].map((r) => ({ ...r, code_token_repair: 1 }))
        : rows[t],
    );
  expect(
    db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name!='seo_code_token_repair_immutable' ORDER BY name",
      )
      .all(),
  ).toEqual(triggers);
  expect(() =>
    db.exec("UPDATE seo_editorial_jobs SET code_token_repair=2"),
  ).toThrow("immutable_code_token_repair");
  db.close();
});
