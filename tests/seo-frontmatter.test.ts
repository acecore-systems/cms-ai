import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  markdown,
  sourceIdentity,
  acceptEditorialChange,
} from "../src/seo-content.ts";
import { buildEditorialInstruction } from "../src/seo-editorial-instruction.ts";
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/seo-frontmatter-colon.json", import.meta.url),
    "utf8",
  ),
);
const now = Date.parse("2026-10-22T19:45:00Z");
const identity = () =>
  sourceIdentity(
    "portal",
    "https://asv.acecore.net/de/stories/minecraft-java-bedrock-crossplay/",
    fixture.files,
    now,
  )!;
const original = fixture.files.find(
  (f: any) => f.path === fixture.proposal.path,
);
const reference = ["https://asv.acecore.net/"];
it("replays the actual failed proposal without changing its title value, body or immutable metadata", async () => {
  const raw = JSON.stringify(fixture.proposal);
  expect(() => markdown(fixture.proposal.content)).toThrow("seo_frontmatter");
  await expect(
    acceptEditorialChange(
      identity(),
      original,
      fixture.proposal,
      fixture.acceptedJa.content,
      now,
      reference,
      1,
    ),
  ).rejects.toThrow("seo_frontmatter");
  const result = await acceptEditorialChange(
    identity(),
    original,
    fixture.proposal,
    fixture.acceptedJa.content,
    now,
    reference,
    2,
  );
  const title = fixture.proposal.content.split("\n")[1].slice(7);
  expect(markdown(result).data.title).toBe(title);
  expect(markdown(result).body).toBe(
    fixture.proposal.content.split("\n---")[1].replace(/^\n/, ""),
  );
  for (const [key, value] of Object.entries(markdown(original.content).data)) {
    if (!["title", "description", "sourceHash", "lastUpdated"].includes(key))
      expect(markdown(result).data[key]).toEqual(value);
  }
  expect(JSON.stringify(fixture.proposal)).toBe(raw);
});
it.each([
  "duplicate",
  "multiline",
  "comment",
  "second-error",
  "other-field",
  "two-scalars",
  "block",
  "quoted",
])("does not repair ambiguous YAML: %s", async (kind) => {
  let text = fixture.proposal.content;
  if (kind === "duplicate")
    text = text.replace("\ndescription:", "\ntitle: duplicate\ndescription:");
  if (kind === "multiline")
    text = text.replace("\ndescription:", "\n  continuation\ndescription:");
  if (kind === "comment")
    text = text.replace("Cross-Play: How", "Cross-Play: How #comment");
  if (kind === "second-error") text = text.replace("author: Gui", "author: [");
  if (kind === "other-field")
    text = text
      .replace(/^title: .*$/m, "title: Valid")
      .replace("author: Gui", "author: Gui: invalid");
  if (kind === "two-scalars")
    text = text.replace("description: Find", "description: Topic: Find");
  if (kind === "block")
    text = text.replace("title: Minecraft", "title: > Minecraft");
  if (kind === "quoted")
    text = text.replace("title: Minecraft", 'title: "Minecraft');
  await expect(
    acceptEditorialChange(
      identity(),
      original,
      { ...fixture.proposal, content: text },
      fixture.acceptedJa.content,
      now,
      reference,
      2,
    ),
  ).rejects.toThrow("seo_frontmatter");
});
it("still rejects other immutable metadata changes after a valid scalar repair", async () => {
  await expect(
    acceptEditorialChange(
      identity(),
      original,
      {
        ...fixture.proposal,
        content: fixture.proposal.content.replace(
          "author: Gui",
          "author: Other",
        ),
      },
      fixture.acceptedJa.content,
      now,
      reference,
      2,
    ),
  ).rejects.toThrow("seo_immutable_metadata");
});
it("old generation instructions and job syntax remain unchanged", () => {
  const args = {
    step: 0,
    paths: ["test.md"],
    translationCount: 8,
    reason: "test",
    research: null,
  };
  expect(buildEditorialInstruction(args)).toBe(
    buildEditorialInstruction({ ...args, syntaxPolicy: 1 }),
  );
  expect(buildEditorialInstruction({ ...args, syntaxPolicy: 2 })).toContain(
    "引用符付き",
  );
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE seo_editorial_jobs(id TEXT PRIMARY KEY,status TEXT); INSERT INTO seo_editorial_jobs VALUES('old','unresolved')",
  );
  const before = db.prepare("SELECT * FROM seo_editorial_jobs").all();
  db.exec(
    readFileSync(
      new URL("../migrations/0014_seo_generation_syntax.sql", import.meta.url),
      "utf8",
    ),
  );
  expect(db.prepare("SELECT id,status FROM seo_editorial_jobs").all()).toEqual(
    before,
  );
  expect(
    db.prepare("SELECT generation_syntax FROM seo_editorial_jobs").get()!
      .generation_syntax,
  ).toBe(1);
  expect(() =>
    db.exec("UPDATE seo_editorial_jobs SET generation_syntax=2"),
  ).toThrow("immutable_generation_syntax");
  db.close();
});
