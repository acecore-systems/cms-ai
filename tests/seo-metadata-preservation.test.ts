import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { prepareEditorialTransport } from "../src/seo-metadata-preservation.ts";
import { prepareCodePreservation } from "../src/seo-code-preservation.ts";
import { markdown } from "../src/seo-content.ts";
const make = (language: string) => ({
  path: language + ".md",
  content: `---
title: "Title ${language}"
description: Description
date: 2026-08-01T10:00:00+09:00
sourceHash: preserved-${language}
lastUpdated: 2026-08-01T10:00:00+09:00
callout:
  title: "${language} callout"
  values: [a, b]
insightGrid: [{title: "${language} insight"}]
processFigure: {steps: [first, second]}
linkCards: [{href: /${language}/guide/, title: Guide}]
---

Original body.

\`\`\`ts
console.log("${language}")
\`\`\`
`,
});
const files = [make("ja"), make("zh-cn")];
const prepare = (source = files) =>
  prepareEditorialTransport(
    source,
    "ja.md",
    "zh-cn.md",
    "instruction",
    2,
    "",
    2,
    ["title", "description", "lastUpdated"],
    2,
  );
it("restores exact target nested metadata and code while keeping all context and editable copy", () => {
  const t = prepare(),
    target = t.files.find((f) => f.path === "zh-cn.md")!;
  expect(Object.keys(markdown(target.content).data)).toEqual([
    "title",
    "description",
  ]);
  const restored = t.restore(
    target.content.replace("Title zh-cn", "Revised zh-cn"),
  );
  const original = markdown(files[1].content).data,
    after = markdown(restored).data;
  expect(after).toEqual({ ...original, title: "Revised zh-cn" });
  expect(restored).toContain('console.log("zh-cn")');
  expect(restored).not.toContain('console.log("ja")');
  const reference = t.files.find((f) =>
    f.path.endsWith(".seo-metadata-context.md"),
  )!;
  for (const language of ["ja", "zh-cn"])
    expect(reference.content).toContain(language + " callout");
  expect(t.files.find((f) => f.path === "ja.md")!.content).not.toContain(
    "callout:",
  );
});
it.each([
  "date: wrong",
  "callout: {title: changed}",
  "sourceHash: changed",
  "lastUpdated: changed",
  "unknown: extra",
  "title: duplicate",
  "description: [not, text]",
])(
  "rejects forbidden/duplicate/nontext field %s rather than overwriting it",
  (addition) => {
    const t = prepare(),
      target = t.files.find((f) => f.path === "zh-cn.md")!;
    expect(() =>
      t.restore(target.content.replace("---\n", "---\n" + addition + "\n")),
    ).toThrow();
  },
);
it("rejects deleted editable fields, metadata file collision and invalid version", () => {
  const t = prepare(),
    target = t.files.find((f) => f.path === "zh-cn.md")!;
  expect(() =>
    t.restore(target.content.replace("description: Description\n", "")),
  ).toThrow("seo_metadata_transport");
  expect(() =>
    prepare([
      ...files,
      { path: "docs/.seo-metadata-context.md", content: "collision" },
    ]),
  ).toThrow();
  expect(() =>
    prepareEditorialTransport(files, "ja.md", "zh-cn.md", "", 2, "", 3, [
      "title",
    ]),
  ).toThrow();
});
it("retains narrow existing YAML repair and rejects foreign code after metadata restoration", () => {
  const t = prepare(),
    target = t.files.find((f) => f.path === "zh-cn.md")!;
  expect(() =>
    t.restore(target.content.replace("\ndescription:", "\n description:")),
  ).not.toThrow();
  expect(() => t.restore(target.content.replace("_F1_", "_F0_"))).toThrow(
    "seo_code_transport",
  );
});
it.each([undefined, 1])(
  "keeps old transport and proposal interpretation exact for version %s",
  (version) => {
    const old = prepareCodePreservation(
      files,
      "ja.md",
      "zh-cn.md",
      "instruction",
      2,
    );
    const t = prepareEditorialTransport(
      files,
      "ja.md",
      "zh-cn.md",
      "instruction",
      2,
      "",
      version,
    );
    expect(t.files).toEqual(old.files);
    expect(t.instruction).toBe(old.instruction);
    const target = t.files.find((f) => f.path === "zh-cn.md")!;
    expect(t.restore(target.content)).toBe(old.restore(target.content));
  },
);
it("0026 preserves all prior rows and triggers; only new jobs opt into immutable version 2", () => {
  const db = new DatabaseSync(":memory:"),
    root = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(root)
    .filter((n) => /^\d+_seo/.test(n) && n < "0026")
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
    readFileSync(new URL("0026_seo_metadata_preservation.sql", root), "utf8"),
  );
  for (const t of tables)
    expect(db.prepare(`SELECT * FROM ${t}`).all()).toEqual(
      t === "seo_editorial_jobs"
        ? rows[t].map((r) => ({ ...r, metadata_preservation: 1 }))
        : rows[t],
    );
  expect(
    db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name!='seo_metadata_preservation_immutable' ORDER BY name",
      )
      .all(),
  ).toEqual(triggers);
  expect(() =>
    db.exec("UPDATE seo_editorial_jobs SET metadata_preservation=2"),
  ).toThrow("immutable_metadata_preservation");
  db.close();
});

it("0027 changes only October cap trigger and preserves every prior row/schema/other trigger", () => {
  const db = new DatabaseSync(":memory:"),
    root = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(root)
    .filter((n) => /^\d+_seo/.test(n) && n < "0027")
    .sort())
    db.exec(readFileSync(new URL(name, root), "utf8"));
  db.exec(
    "INSERT INTO seo_budget_runs(id,article_key,created_at,deadline) VALUES('old','article',1,2);INSERT INTO seo_budget_runs(id,article_key,created_at,deadline,run_limit_micros) VALUES('new','article2',1,2,1250000);INSERT INTO seo_budget_calls(id,run_id,month_jst,request_sha256,reserved_micros,created_at,status) VALUES('call','old','2026-10','hash',1000000,1,'unresolved')",
  );
  const tables = db
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    .all();
  const rows = () =>
    tables.map((t) => db.prepare(`SELECT * FROM ${t.name}`).all());
  const before = rows();
  const triggers = db
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
    )
    .all();
  db.exec(
    readFileSync(
      new URL("0027_seo_october_budget_extension.sql", root),
      "utf8",
    ),
  );
  expect(rows()).toEqual(before);
  expect(
    db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all(),
  ).toEqual(tables);
  expect(
    db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
      )
      .all(),
  ).toEqual(
    triggers.map((t) =>
      t.name === "seo_budget_cap"
        ? { ...t, sql: String(t.sql).replace("10000000", "11000000") }
        : t,
    ),
  );
  expect(() =>
    db.exec(
      "UPDATE seo_budget_runs SET run_limit_micros=1250000 WHERE id='old'",
    ),
  ).toThrow("immutable_run_limit");
  db.close();
});
