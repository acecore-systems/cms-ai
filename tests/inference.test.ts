import { describe, expect, it, vi } from "vitest";

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
  it("現在と過去の画像を元のuser turnに付けて渡す", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const attachment = {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      name: "reference.png",
      type: "image/png" as const,
      size: 3,
    };
    const run = vi.fn().mockResolvedValue({
      response: {
        changes: [],
        summary: "回答",
        clarification: "青い四角です",
      },
    });
    const get = vi
      .fn()
      .mockResolvedValue({ size: 3, arrayBuffer: async () => bytes.buffer });
    const env = { AI: { run }, CMS_AI_IMAGES: { get } } as unknown as AppEnv;
    const previous = job({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      attachments: [attachment],
      turnNumber: 1,
      status: "responded",
    });
    const current = job({ attachments: [attachment], turnNumber: 2 });
    await runInference(
      env,
      site,
      current,
      [{ path: "src/pages/index.astro", content: "<main/>" }],
      [previous, current],
    );
    const input = run.mock.calls[0][1];
    expect(input.messages[1].content[1].image_url.url).toBe(
      "data:image/png;base64,AQID",
    );
    expect(input.messages[3].content[1].image_url.url).toBe(
      "data:image/png;base64,AQID",
    );
    expect(get.mock.calls.map((call) => call[0])).toEqual([
      `attachments/${current.id}/${attachment.id}`,
      `attachments/${previous.id}/${attachment.id}`,
    ]);
  });

  it("推論失敗に含まれる画像データをログやエラーに出さない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const run = vi.fn().mockRejectedValue(new Error("private-image-payload"));
      await expect(
        runInference(
          { AI: { run } } as unknown as AppEnv,
          site,
          job(),
          [{ path: "src/pages/index.astro", content: "<main/>" }],
          [],
        ),
      ).rejects.toThrow(/AIの応答/);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        "private-image-payload",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("添付のprivate URLや画像データを生成コードへ混入させない", () => {
    for (const content of [
      '<img src="data:image/png;base64,AQID">',
      '<img src="/admin/api/ai/jobs/123/images/456">',
    ]) {
      expect(() =>
        parseInferenceResponse(site, {
          response: {
            changes: [
              { content, path: "src/pages/index.astro", reason: "画像を追加" },
            ],
            summary: "変更",
            clarification: "",
          },
        }),
      ).toThrow(/許可された/);
    }
  });
  it("GLM-5.3-Flashへeffortと会話履歴を渡しeditorの変更を許可する", async () => {
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
    expect(calls[0].model).toBe("@cf/zai-org/glm-5.3-flash");
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
    attachments: [],
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
