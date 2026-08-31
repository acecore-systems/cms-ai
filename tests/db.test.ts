import { describe, expect, it } from "vitest";

import { createJob } from "../src/db.ts";
import type { AppEnv } from "../src/env.ts";

const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const previousId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const prUrl = "https://github.com/acecore-systems/homepage-hatt/pull/123";

describe("conversation job storage", () => {
  it("追加入力を同じbranch・Pull Requestの次turnとして保存する", async () => {
    let inserted: unknown[] = [];
    const db = createDb([previousRow()]);
    db.onInsert = (values) => {
      inserted = values;
    };
    const result = await createJob({ CMS_AI_DB: db } as unknown as AppEnv, {
      conversationId,
      instruction: "もう少し短くして",
      reasoningEffort: "high",
      requestedBy: "editor@example.com",
      requestedRole: "editor",
      siteId: "homepage-hatt",
    });

    expect(result.turnNumber).toBe(2);
    expect(result.branchName).toBe("ai/cms-" + conversationId);
    expect(result.prUrl).toBe(prUrl);
    expect(inserted[11]).toBe(prUrl);
  });

  it("他人または存在しない会話IDから会話を新設しない", async () => {
    const db = createDb([]);
    await expect(
      createJob({ CMS_AI_DB: db } as unknown as AppEnv, {
        conversationId,
        instruction: "追加入力",
        reasoningEffort: "medium",
        requestedBy: "other@example.com",
        requestedRole: "editor",
        siteId: "homepage-hatt",
      }),
    ).rejects.toThrow(/会話が見つかりません/);
  });
});

function createDb(rows: ReturnType<typeof previousRow>[]) {
  const db = {
    onInsert: (_values: unknown[]) => {},
    prepare(query: string) {
      let values: unknown[] = [];
      return {
        bind(...nextValues: unknown[]) {
          values = nextValues;
          return this;
        },
        async all() {
          return { results: rows };
        },
        async run() {
          if (query.startsWith("INSERT INTO cms_ai_jobs")) db.onInsert(values);
          return { meta: { changes: 1 } };
        },
      };
    },
  };
  return db;
}

function previousRow() {
  const now = new Date().toISOString();
  return {
    assistant_message: "見出しを確認しました。",
    branch_name: "ai/cms-" + conversationId,
    changed_paths_json: '["src/pages/index.astro"]',
    clarification: null,
    conversation_id: conversationId,
    created_at: now,
    error_message: null,
    id: previousId,
    instruction: "見出しを短くして",
    pr_url: prUrl,
    reasoning_effort: "medium",
    requested_by: "editor@example.com",
    requested_role: "editor",
    site_id: "homepage-hatt",
    status: "pr_created",
    summary: "PRを作成しました。",
    turn_number: 1,
    updated_at: now,
  };
}
