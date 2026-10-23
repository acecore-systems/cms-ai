import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { prepareCodePreservation } from "../src/seo-code-preservation.ts";
import { acceptEditorialChange, sourceIdentity } from "../src/seo-content.ts";
const path = "src/content/blog/example.md",
  pt = "src/content/blog/pt/example.md";
const header = '---\ntitle: Original\ndate: "2026-10-01"\n---\n\n';
const ja =
  header +
  'Original Japanese paragraph.\n\n```ts\nconst message = "日本語";\n```\n\n```txt\n日本語の指示\n```\n';
const translated =
  header +
  'Original Portuguese paragraph.\n\n```ts\nconst message = "Português";\n```\n\n```txt\nInstruções em português\n```\n';
const files = [
  { path, content: ja },
  { path: pt, content: translated },
];
const tokens = (s: string) => s.match(/<!--CMS_SEO_CODE_V1_[^>]+-->/g) || [];
function fixture() {
  const t = prepareCodePreservation(files, path, pt, "Original instruction", 2);
  return { ...t, target: t.files.find((f) => f.path === pt)!.content };
}
it("restores target-language code rather than Japanese code and retains full read-only context", () => {
  const f = fixture(),
    result = f.restore(
      f.target.replace("Original Portuguese", "Revised Portuguese"),
    );
  expect(result).toBe(
    translated.replace("Original Portuguese", "Revised Portuguese"),
  );
  expect(f.files.at(-1)!.content).toContain('const message = "日本語";');
  expect(f.files.at(-1)!.content).toContain('const message = "Português";');
  expect(files[1].content).toBe(translated);
  expect(f.instruction).toContain("TARGET-language original code");
});
it.each([
  "foreign",
  "missing",
  "duplicate",
  "reordered",
  "raw",
  "inline",
  "nested",
  "metadata",
  "unknown",
  "malformed",
])("rejects %s placeholder manipulation before ordinary guards", (kind) => {
  const f = fixture(),
    ts = tokens(f.target);
  let output = f.target;
  if (kind === "foreign")
    output = output.replace(ts[0], tokens(f.files[0].content)[0]);
  if (kind === "missing") output = output.replace(ts[0], "");
  if (kind === "duplicate") output += "\n" + ts[0];
  if (kind === "reordered")
    output = output
      .replace(ts[0], "TEMP")
      .replace(ts[1], ts[0])
      .replace("TEMP", ts[1]);
  if (kind === "raw") output = translated;
  if (kind === "inline") output = output.replace(ts[0], "inline " + ts[0]);
  if (kind === "nested") output = output.replace(ts[0], "> " + ts[0]);
  if (kind === "metadata")
    output = output
      .replace("title: Original", "title: " + ts[0])
      .replace("\n" + ts[0], "");
  if (kind === "unknown") output += "\n<!--CMS_SEO_CODE_V1_F9_B9-->";
  if (kind === "malformed")
    output = output.replace(ts[0], ts[0].replace("-->", "-->garbage"));
  expect(() => f.restore(output)).toThrow("seo_code_transport");
});
it("cannot hide a raw block alongside valid tokens", () => {
  const f = fixture();
  expect(() => f.restore(f.target + "\n```js\nchanged();\n```")).toThrow(
    "seo_code_transport",
  );
});
it.each([
  "~~~ts\r\nconst x = 1;\r\n~~~",
  "````md\n```js\nembedded();\n```\n````",
  "    indented code\n    exact whitespace",
  "```\nno language\n```",
  "```js\nunclosed code",
])("restores exact code slices including fence/line endings: %s", (code) => {
  const original = header + "Original prose.\n\n" + code + "\n";
  const f = prepareCodePreservation(
    [{ path, content: original }],
    path,
    path,
    "instruction",
    2,
  );
  expect(f.restore(f.files[0].content)).toBe(original);
});
it("rejects ambiguous input markers and unsupported nested code without altering source", () => {
  for (const content of [
    ja + "\nCMS_SEO_CODE_V1_collision",
    header + "> ```ts\n> example();\n> ```\n",
  ])
    expect(() =>
      prepareCodePreservation(
        [{ path, content }],
        path,
        path,
        "instruction",
        2,
      ),
    ).toThrow("seo_code_transport");
});
it("legacy transport is byte-identical and interprets no markers", () => {
  for (const version of [undefined, 1]) {
    const f = prepareCodePreservation(files, path, pt, "legacy", version);
    expect(f.files).toBe(files);
    expect(f.instruction).toBe("legacy");
    expect(f.restore("CMS_SEO_CODE_V1_arbitrary")).toBe(
      "CMS_SEO_CODE_V1_arbitrary",
    );
  }
  expect(() => prepareCodePreservation(files, path, pt, "legacy", 3)).toThrow();
});
it("restoration does not relax the existing metadata/URL guards", async () => {
  const source = { path, content: ja },
    identity = sourceIdentity(
      "cherry",
      "https://cherry.acecore.net/blog/example/",
      [source],
    )!;
  const f = prepareCodePreservation([source], path, path, "instruction", 2);
  const safe = f.restore(
    f.files[0].content.replace("Original Japanese", "Revised Japanese"),
  );
  await expect(
    acceptEditorialChange(
      identity,
      source,
      { path, content: safe },
      null,
      Date.now(),
      [],
      2,
    ),
  ).resolves.toBeTruthy();
  await expect(
    acceptEditorialChange(
      identity,
      source,
      { path, content: safe.replace("2026-10-01", "2026-09-01") },
      null,
      Date.now(),
      [],
      2,
    ),
  ).rejects.toThrow("seo_immutable_metadata");
  await expect(
    acceptEditorialChange(
      identity,
      source,
      { path, content: safe + "\nhttps://evil.example/unverified" },
      null,
      Date.now(),
      [],
      2,
    ),
  ).rejects.toThrow("seo_unverified_reference");
});
it("0024 preserves all prior rows and triggers; only new jobs opt into immutable version 2", () => {
  const db = new DatabaseSync(":memory:"),
    root = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(root)
    .filter((n) => /^\d+_seo/.test(n) && n < "0024")
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
    readFileSync(new URL("0024_seo_code_preservation.sql", root), "utf8"),
  );
  for (const t of tables)
    expect(db.prepare(`SELECT * FROM ${t}`).all()).toEqual(
      t === "seo_editorial_jobs"
        ? rows[t].map((r) => ({ ...r, code_preservation: 1 }))
        : rows[t],
    );
  expect(
    db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name!='seo_code_preservation_immutable' ORDER BY name",
      )
      .all(),
  ).toEqual(triggers);
  expect(() =>
    db.exec("UPDATE seo_editorial_jobs SET code_preservation=2"),
  ).toThrow("immutable_code_preservation");
  db.close();
});
