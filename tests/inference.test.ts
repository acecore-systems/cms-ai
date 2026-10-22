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
const deepSeekModel = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";

describe("Workers AI inference", () => {
  it.each([
    ["low", "low"],
    ["medium", "high"],
    ["high", "high"],
    ["max", "max"],
  ] as const)(
    "DeepSeekの編集へ%sを%sとして送りschema付き応答を検証する",
    async (effort, mappedEffort) => {
      const change = {
        content: "<main>after</main>\n",
        path: "src/pages/index.astro",
        reason: "依頼された文言を更新します。",
      };
      const run = vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                changes: [change],
                clarification: "",
                summary: "トップページを更新しました。",
              }),
            },
          },
        ],
      });
      const getKey = vi.fn();
      const result = await runInference(
        {
          AI: { run },
          CMS_AI_MODEL: deepSeekModel,
          SEO_AI_MODEL: "gpt-6-luna",
          OPENAI_API_KEY_STORE: { get: getKey },
        } as unknown as AppEnv,
        site,
        job({ reasoningEffort: effort }),
        [{ content: "<main>before</main>\n", path: change.path }],
        [],
        "見出しはmain内だけを修正してください。",
      );
      expect(run).toHaveBeenCalledTimes(1);
      const [model, input] = run.mock.calls[0];
      expect(model).toBe(deepSeekModel);
      expect(input).toMatchObject({
        max_completion_tokens: 12_000,
        reasoning_effort: mappedEffort,
        store: false,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "cms_ai_changes",
            strict: true,
            schema: { required: ["summary", "clarification", "changes"] },
          },
        },
      });
      expect(input.messages.at(-1).content).toContain(
        "見出しはmain内だけを修正してください。",
      );
      expect(result.changes).toEqual([change]);
      expect(getKey).not.toHaveBeenCalled();
    },
  );

  it("DeepSeek失敗時はschemaを外した再送やOpenAIへの切替をしない", async () => {
    const run = vi.fn().mockRejectedValue(new Error("provider_failed"));
    const getKey = vi.fn();
    await expect(
      runInference(
        {
          AI: { run },
          CMS_AI_MODEL: deepSeekModel,
          OPENAI_API_KEY_STORE: { get: getKey },
        } as unknown as AppEnv,
        site,
        job(),
        [{ content: "<main/>\n", path: "src/pages/index.astro" }],
        [],
      ),
    ).rejects.toThrow(/AIの応答/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(getKey).not.toHaveBeenCalled();
  });

  it("DeepSeekでも許可範囲外の変更を拒否する", async () => {
    const run = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              changes: [
                { content: "unsafe", path: "package.json", reason: "変更" },
              ],
              clarification: "",
              summary: "変更",
            }),
          },
        },
      ],
    });
    await expect(
      runInference(
        { AI: { run }, CMS_AI_MODEL: deepSeekModel } as unknown as AppEnv,
        site,
        job(),
        [{ content: "<main/>\n", path: "src/pages/index.astro" }],
        [],
      ),
    ).rejects.toThrow(/許可された/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("SEOの予算確保が失敗した場合はAPI呼出しとfallbackを行わない", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    try {
      await expect(
        runInference(
          {
            CMS_AI_MODEL: deepSeekModel,
            SEO_AI_MODEL: "gpt-6-luna",
            OPENAI_API_KEY_STORE: { get: async () => "fixture-key" },
          } as unknown as AppEnv,
          site,
          job(),
          [{ path: "src/pages/index.astro", content: "test" }],
          [],
          undefined,
          async () => {
            throw new Error("budget");
          },
          undefined,
          "seo",
        ),
      ).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("SEOの送信前guardに確定payloadを渡し、結果不明でも再試行しない", async () => {
    const order: string[] = [];
    const fetcher = vi.fn(async () => {
      order.push("request");
      throw new Error("unknown");
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      await expect(
        runInference(
          {
            CMS_AI_MODEL: deepSeekModel,
            SEO_AI_MODEL: "gpt-6-luna",
            OPENAI_API_KEY_STORE: { get: async () => "fixture-key" },
          } as unknown as AppEnv,
          site,
          job(),
          [{ path: "src/pages/index.astro", content: "test" }],
          [],
          undefined,
          async (model, request) => {
            expect(model).toBe("gpt-6-luna");
            expect(request.service_tier).toBe("default");
            expect(request.max_completion_tokens).toBe(12000);
            order.push("reserved");
          },
          undefined,
          "seo",
        ),
      ).rejects.toThrow();
      expect(order).toEqual(["reserved", "request"]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
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
    const env = {
      AI: { run },
      CMS_AI_IMAGES: { get },
      CMS_AI_MODEL: deepSeekModel,
    } as unknown as AppEnv;
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
    expect(run.mock.calls[0][0]).toBe(deepSeekModel);
    expect(input.reasoning_effort).toBe("high");
    expect(input.response_format.json_schema.strict).toBe(true);
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
          {
            AI: { run },
            CMS_AI_MODEL: "@cf/example/chat-model",
          } as unknown as AppEnv,
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
  it("DeepSeekへeffortと会話履歴を渡す", async () => {
    const calls: Array<{ input: any; model: string; options: any }> = [];
    const env = {
      CMS_AI_MODEL: deepSeekModel,
      AI: {
        async run(model: string, input: unknown, options: any) {
          calls.push({ input, model, options });
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
    expect(calls[0].model).toBe(deepSeekModel);
    expect(calls[0].options).toBe(undefined);
    expect(calls[0].input.reasoning_effort).toBe("high");
    expect(calls[0].input.response_format.type).toBe("json_schema");
    expect(calls[0].input.messages.map((message: any) => message.role)).toEqual(
      ["system", "user", "assistant", "user"],
    );
    expect(result.changes[0].path).toBe("src/pages/index.astro");
  });

  it("chat権限ではモデルが変更を返してもサーバー側で変更を空にする", async () => {
    const env = {
      CMS_AI_MODEL: deepSeekModel,
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

  it("summaryに入った会話回答を既存のOpenAI呼び出し一回で受け取る", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  changes: [],
                  clarification: "",
                  summary: "CMS inference canary OK",
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const result = await runInference(
        {
          CMS_AI_MODEL: "gpt-6-luna",
          OPENAI_API_KEY_STORE: { get: async () => "fixture-key" },
        } as unknown as AppEnv,
        site,
        job(),
        [{ content: "<main>before</main>", path: "src/pages/index.astro" }],
        [],
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][0]).toBe(
        "https://api.openai.com/v1/chat/completions",
      );
      expect(result).toEqual({
        changes: [],
        clarification: "CMS inference canary OK",
        summary: "CMS inference canary OK",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["", " \n\t"])(
    "回答と変更案が両方空の場合は空文字%sでもエラーにする",
    (text) => {
      expect(() =>
        parseInferenceResponse(site, {
          response: { changes: [], clarification: text, summary: text },
        }),
      ).toThrow(/AIから回答または変更案/);
    },
  );
});

describe("inference response validation", () => {
  const change = {
    content: "<main>after</main>\n",
    path: "src/pages/index.astro",
    reason: "依頼された変更",
  };
  const proposal = {
    changes: [change],
    clarification: "",
    summary: "private-answer",
  };
  const completion = (value: unknown, extra: Record<string, unknown> = {}) => ({
    choices: [
      {
        finish_reason: "stop",
        message: { content: JSON.stringify(value) },
        ...extra,
      },
    ],
  });

  async function rejectsWithDiagnostic(
    value: unknown,
    phase: string,
    reason: string,
  ) {
    const run = vi.fn().mockResolvedValue(value);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        runInference(
          { AI: { run }, CMS_AI_MODEL: deepSeekModel } as unknown as AppEnv,
          site,
          job({ instruction: "private-instruction" }),
          [{ path: change.path, content: "private-source" }],
          [],
        ),
      ).rejects.toMatchObject({ phase, reason });
      expect(run).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(warn.mock.calls[0][0])).toEqual({
        event: "cms_ai_response_rejected",
        model: deepSeekModel,
        purpose: "cms",
        phase,
        reason,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(
        /private-|index\.astro|data:image/,
      );
    } finally {
      warn.mockRestore();
    }
  }

  it.each([
    ["length", "length"],
    ["content_filter", "content_filter"],
    ["tool_calls", "tool_calls"],
    ["function_call", "function_call"],
    [null, "unknown_finish_reason"],
    ["private-finish-reason", "unknown_finish_reason"],
  ])(
    "完了しなかった%sは有効なJSON変更案でも受理しない",
    async (finishReason, reason) => {
      await rejectsWithDiagnostic(
        completion(proposal, { finish_reason: finishReason }),
        "completion",
        String(reason),
      );
    },
  );

  it("responseオブジェクトがあっても不完全なchoicesを迂回できない", () => {
    expect(() =>
      parseInferenceResponse(site, {
        response: proposal,
        ...completion(proposal, { finish_reason: "length" }),
      }),
    ).toThrow(/出力上限/);
  });

  it("refusal付き応答のJSONを受理せず拒否本文も記録しない", async () => {
    await rejectsWithDiagnostic(
      completion(proposal, {
        message: {
          content: JSON.stringify(proposal),
          refusal: "private-refusal",
        },
      }),
      "completion",
      "refusal",
    );
  });

  it.each([
    [
      { choices: [{ finish_reason: "stop", message: { content: null } }] },
      "envelope",
      "missing_content",
    ],
    [{ response: 'private-prefix {"changes":[]}' }, "json", "invalid_json"],
    [{ response: '{"changes":[' }, "json", "invalid_json"],
    [{ response: "[]" }, "shape", "invalid_result"],
    [completion({ summary: "private-answer" }), "shape", "changes_count"],
    [
      completion({ ...proposal, changes: [{ ...change, content: null }] }),
      "shape",
      "change_shape",
    ],
    [
      completion({ changes: [], summary: "", clarification: "" }),
      "shape",
      "missing_answer",
    ],
    [
      completion({
        ...proposal,
        changes: [{ ...change, path: "package.json" }],
      }),
      "policy",
      "disallowed_path",
    ],
    [
      completion({ ...proposal, changes: [change, change] }),
      "policy",
      "duplicate_path",
    ],
    [
      completion({ ...proposal, changes: [{ ...change, reason: "" }] }),
      "policy",
      "invalid_change_reason",
    ],
    [
      completion({ ...proposal, changes: [{ ...change, content: "" }] }),
      "policy",
      "change_size",
    ],
    [
      completion({
        ...proposal,
        changes: [{ ...change, content: "x".repeat(256 * 1024 + 1) }],
      }),
      "policy",
      "change_size",
    ],
    [
      completion({
        ...proposal,
        changes: [
          {
            ...change,
            content: '<img src="data:image/png;base64,private-image">',
          },
        ],
      }),
      "policy",
      "private_image_reference",
    ],
    [
      completion({
        ...proposal,
        changes: [{ ...change, content: "private-content\u0000" }],
      }),
      "policy",
      "null_character",
    ],
    [
      completion({
        ...proposal,
        changes: ["one", "two", "three"].map((name) => ({
          ...change,
          path: `src/pages/${name}.astro`,
          content: "x".repeat(180 * 1024),
        })),
      }),
      "policy",
      "total_change_size",
    ],
  ])(
    "不正応答の診断ケース%#は本文を記録せず区別する",
    async (value, phase, reason) => {
      await rejectsWithDiagnostic(value, String(phase), String(reason));
    },
  );

  it.each([
    { response: proposal },
    { response: JSON.stringify(proposal) },
    completion(proposal),
    { choices: [{ message: { content: JSON.stringify(proposal) } }] },
  ])("正常なChat Completionsと既存Workers AI形式を維持する", (value) => {
    expect(parseInferenceResponse(site, value).changes).toEqual([change]);
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
