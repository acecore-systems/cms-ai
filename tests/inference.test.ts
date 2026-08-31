import { describe, expect, it } from "vitest";

import type { AppEnv } from "../src/env.ts";
import {
  parseInferenceResponse,
  runInference,
  validateSourceFiles,
} from "../src/inference.ts";
import type { Job, Role } from "../src/models.ts";
import { getSiteById } from "../src/sites.ts";

const site = getSiteById("homepage-hatt")!;

describe("Workers AI inference", () => {
  it("GLM-5.3へeffortと会話履歴を渡しeditorの変更を許可する", async () => {
    const calls: Array<{ input: any; model: string }> = [];
    const env = {
      AI: {
        async run(model: string, input: unknown) {
          calls.push({ input, model });
          return {
            response: {
              changes: [
                {
                  content: "<main>after</main>\n",
                  path: "src/pages/index.astro",
                  reason: "依頼された文言を更新します。",
                },
              ],
              clarification: "",
              summary: "トップページを更新しました。",
            },
          };
        },
      },
      CMS_AI_MODEL: "@cf/zai-org/glm-5.3",
    } as unknown as AppEnv;
    const previous = job({
      assistantMessage: "現在の見出しを確認しました。",
      instruction: "見出しを確認して",
      status: "responded",
      turnNumber: 1,
    });
    const current = job({
      instruction: "では、その見出しを短くして",
      reasoningEffort: "high",
      turnNumber: 2,
    });
    const result = await runInference(
      env,
      site,
      current,
      [{ content: "<main>before</main>\n", path: "src/pages/index.astro" }],
      [previous, current],
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("@cf/zai-org/glm-5.3");
    expect(calls[0].input.reasoning_effort).toBe("high");
    expect(calls[0].input.response_format.type).toBe("json_schema");
    expect(calls[0].input.messages.map((message: any) => message.role)).toEqual(
      ["system", "user", "assistant", "user"],
    );
    expect(result.changes[0].path).toBe("src/pages/index.astro");
  });

  it("chat権限ではモデルが変更を返してもサーバー側で変更を空にする", async () => {
    const env = {
      AI: {
        async run() {
          return {
            response: {
              changes: [
                {
                  content: "<main>changed</main>",
                  path: "src/pages/index.astro",
                  reason: "変更案です。",
                },
              ],
              clarification: "",
              summary: "変更案を説明します。",
            },
          };
        },
      },
    } as unknown as AppEnv;
    const result = await runInference(
      env,
      site,
      job({ requestedRole: "chat" }),
      [{ content: "<main>before</main>", path: "src/pages/index.astro" }],
      [],
    );

    expect(result.changes).toEqual([]);
    expect(result.clarification).toBe("変更案を説明します。");
  });

  it("許可範囲外のモデル変更とsourceを拒否する", () => {
    expect(() =>
      parseInferenceResponse(site, {
        response: {
          changes: [
            {
              content: "name: unsafe",
              path: ".github/workflows/ci.yml",
              reason: "workflow変更",
            },
          ],
          clarification: "",
          summary: "workflowを変更します。",
        },
      }),
    ).toThrow(/許可された/);
    expect(() =>
      validateSourceFiles(site, [
        { content: "secret", path: "functions/admin/secret.ts" },
      ]),
    ).toThrow(/ソース範囲/);
  });

  it("fallbackのJSON code fenceも解析する", () => {
    expect(
      parseInferenceResponse(site, {
        response:
          '```json\n{"changes":[],"clarification":"確認します。","summary":"回答しました。"}\n```',
      }),
    ).toEqual({
      changes: [],
      clarification: "確認します。",
      summary: "回答しました。",
    });
  });

  it("会話回答があれば空のsummaryを安全に補完する", () => {
    expect(
      parseInferenceResponse(site, {
        response: {
          changes: [],
          clarification: "Cherry CMS AI canary OK",
          summary: "",
        },
      }),
    ).toEqual({
      changes: [],
      clarification: "Cherry CMS AI canary OK",
      summary: "Cherry CMS AI canary OK",
    });
  });
});

function job(overrides: Partial<Job> = {}): Job {
  const now = new Date().toISOString();
  return {
    assistantMessage: null,
    branchName: "ai/cms-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    changedPaths: [],
    clarification: null,
    conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    createdAt: now,
    errorMessage: null,
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    instruction: "現在のページについて教えて",
    prUrl: null,
    reasoningEffort: "medium",
    requestedBy: "member@example.com",
    requestedRole: "editor" as Role,
    siteId: site.id,
    status: "queued",
    summary: null,
    turnNumber: 1,
    updatedAt: now,
    ...overrides,
  };
}
