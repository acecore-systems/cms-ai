import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../src/env.ts";
import {
  parseInferenceResponse,
  runInference,
  validateSourceFiles,
} from "../src/inference.ts";
import type { Job, Role } from "../src/models.ts";
import { classifyEditIntent, type EditIntent } from "../src/edit-intent.ts";
import { selectConversationJobs } from "../src/conversation.ts";
import { getSiteById } from "../src/sites.ts";
import intentFixtures from "./fixtures/edit-intent.json";

const site = getSiteById("homepage-hatt")!;
const intentEnv = {
  CMS_AI_DECISIONS_MODEL: "gpt-6-luna",
  OPENAI_API_KEY_STORE: { get: async () => "test-api-key" },
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => decisionResponse("edit_requested")),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
    const env = {
      ...intentEnv,
      AI: { run },
      CMS_AI_IMAGES: { get },
      CMS_AI_MODEL: "@cf/example/chat-model",
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
            ...intentEnv,
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
  it("Workers AIへ画像入力・effortと会話履歴を渡す", async () => {
    const calls: Array<{ input: any; model: string; options: any }> = [];
    const env = {
      ...intentEnv,
      CMS_AI_MODEL: "@cf/example/chat-model",
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
    expect(calls[0].model).toBe("@cf/example/chat-model");
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
      ...intentEnv,
      CMS_AI_MODEL: "@cf/example/chat-model",
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
    expect(result.clarification).toContain("ファイル変更は行っていません");
    expect(fetch).not.toHaveBeenCalled();
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

describe("CMS edit intent boundary", () => {
  it("実モデル用評価例に不正な履歴を含めない", () => {
    expect(intentFixtures.cases).toHaveLength(23);
    for (const fixture of intentFixtures.cases) {
      expect(typeof fixture.instruction).toBe("string");
      expect(Array.isArray(fixture.history)).toBe(true);
      for (const turn of fixture.history) {
        expect(turn).not.toBeNull();
        expect(typeof turn.user).toBe("string");
        expect(typeof turn.assistant).toBe("string");
      }
    }
  });

  it("失敗した過去ジョブの検証ログを意図判定へ含めない", async () => {
    await classifyEditIntent(
      intentEnv as unknown as AppEnv,
      job({ turnNumber: 2, instruction: "もう一度実施して" }),
      [
        job({
          turnNumber: 1,
          status: "failed",
          instruction: "見出しを短くして",
          errorMessage: "private-validation-history",
        }),
      ],
    );
    const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(request.input).not.toContain("private-validation-history");
    expect(JSON.parse(request.input).history).toEqual([
      { user: "見出しを短くして", assistant: "前回の処理は完了していません。" },
    ]);
  });

  it.each(["discussion_only", "unclear"] as const)(
    "%sでは生成モデルが変更を返しても採用・変更完了表示をしない",
    async (intent) => {
      vi.mocked(fetch).mockImplementation(async () => decisionResponse(intent));
      const run = vi.fn(async () => ({
        response: {
          changes: [
            {
              path: "src/pages/index.astro",
              content: "<main>unexpected edit</main>",
              reason: "変更しました",
            },
          ],
          clarification: "変更しました",
          summary: "見出しを変更しました",
        },
      }));
      const result = await runInference(
        {
          ...intentEnv,
          AI: { run },
          CMS_AI_MODEL: "@cf/example/chat-model",
        } as unknown as AppEnv,
        site,
        job({ instruction: "候補を3つ出して。反映はしないで" }),
        [{ content: "<main>before</main>", path: "src/pages/index.astro" }],
        [],
      );
      expect(result.changes).toEqual([]);
      expect(result.summary).toBe("ファイル変更は行っていません。");
      expect(result.clarification).toContain("ファイル変更は行っていません");
      expect(
        run.mock.calls[0][1].response_format.json_schema.properties.changes
          .maxItems,
      ).toBe(0);
    },
  );

  it("相談への回答は保持し、ソースと検証ログを意図判定へ送らない", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      decisionResponse("discussion_only"),
    );
    const run = vi.fn(async () => ({
      response: {
        changes: [],
        clarification: "見出しの候補を説明します。",
        summary: "候補を説明しました。",
      },
    }));
    const result = await runInference(
      {
        ...intentEnv,
        AI: { run },
        CMS_AI_MODEL: "@cf/example/chat-model",
      } as unknown as AppEnv,
      site,
      job({ instruction: "見出しの候補を3つ出して" }),
      [{ content: "private-source-text", path: "src/pages/index.astro" }],
      [],
      "private-validation-log",
    );
    expect(result.clarification).toBe("見出しの候補を説明します。");
    const decisionInput = String(vi.mocked(fetch).mock.calls[0][1]?.body);
    expect(decisionInput).not.toContain("private-source-text");
    expect(decisionInput).not.toContain("private-validation-log");
    expect(decisionInput).not.toContain("member@example.com");
    expect(decisionInput).not.toContain("test-api-key");
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
      "見出しの候補",
    );
  });

  it("OpenAIでは明示編集の判定後に既存の生成APIを呼ぶ", async () => {
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url).endsWith("/decisions")
        ? decisionResponse("edit_requested")
        : Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    changes: [
                      {
                        content: "<main>after</main>",
                        path: "src/pages/index.astro",
                        reason: "依頼された更新",
                      },
                    ],
                    clarification: "",
                    summary: "変更案を作成しました。",
                  }),
                },
              },
            ],
          }),
    );
    const result = await runInference(
      { ...intentEnv, CMS_AI_MODEL: "gpt-6-luna" } as unknown as AppEnv,
      site,
      job(),
      [{ content: "<main>before</main>", path: "src/pages/index.astro" }],
      [],
    );
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      "https://api.openai.com/v1/decisions",
      "https://api.openai.com/v1/chat/completions",
    ]);
    expect(result.changes[0].content).toBe("<main>after</main>");
    const generatedRequest = JSON.parse(
      String(vi.mocked(fetch).mock.calls[1][1]?.body),
    );
    expect(generatedRequest.store).toBe(false);
    expect(generatedRequest.reasoning_effort).toBe("medium");
    expect(
      generatedRequest.response_format.json_schema.schema.properties.changes
        .maxItems,
    ).toBe(20);
  });

  it.each([
    {},
    { answers: [] },
    {
      answers: [
        {
          name: "edit_intent",
          type: "refusal",
          refusal: "private-provider-detail",
        },
      ],
    },
    {
      answers: [
        { name: "other_question", type: "choice", choice: "edit_requested" },
      ],
    },
    {
      answers: [
        { name: "edit_intent", type: "choice", choice: "unexpected_value" },
      ],
    },
    { answers: [{ name: "edit_intent", type: "predicate", probability: 1 }] },
    {
      answers: [
        { name: "edit_intent", type: "choice", choice: "edit_requested" },
        { name: "edit_intent", type: "choice", choice: "edit_requested" },
      ],
    },
  ])("拒否や不正な判定応答では文章生成を開始しない: %j", async (body) => {
    vi.mocked(fetch).mockImplementation(async () => Response.json(body));
    const run = vi.fn();
    await expect(
      runInference(
        {
          ...intentEnv,
          AI: { run },
          CMS_AI_MODEL: "@cf/example/chat-model",
        } as unknown as AppEnv,
        site,
        job(),
        [{ content: "<main>before</main>", path: "src/pages/index.astro" }],
        [],
      ),
    ).rejects.toThrow("編集依頼かどうかを確認できませんでした");
    expect(run).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
  });

  it.each(["http", "network", "invalid_json", "oversized"])(
    "判定APIの%s障害を別APIへのフォールバックや詳細漏えいにしない",
    async (failure) => {
      vi.mocked(fetch).mockImplementation(async () => {
        if (failure === "network") throw new Error("private-provider-detail");
        if (failure === "http")
          return new Response("private-provider-detail", { status: 503 });
        if (failure === "oversized") return new Response("x".repeat(64_001));
        return new Response("private-provider-detail");
      });
      let error: unknown;
      try {
        await classifyEditIntent(intentEnv as unknown as AppEnv, job(), []);
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).toContain("編集依頼かどうかを確認できませんでした");
      expect(String(error)).not.toContain("private-provider-detail");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("chat権限は意図判定の設定やAPIに依存せず会話だけ返せる", async () => {
    const run = vi.fn(async () => ({
      response: {
        changes: [],
        clarification: "説明します。",
        summary: "回答しました。",
      },
    }));
    const result = await runInference(
      {
        AI: { run },
        CMS_AI_MODEL: "@cf/example/chat-model",
      } as unknown as AppEnv,
      site,
      job({ requestedRole: "chat", instruction: "トップページを編集して" }),
      [{ content: "<main>before</main>", path: "src/pages/index.astro" }],
      [],
    );
    expect(result.changes).toEqual([]);
    expect(result.clarification).toBe("説明します。");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("同じ会話・所有者・サイトの過去ターンだけを判定と生成で共有する", async () => {
    const current = job({ turnNumber: 3, instruction: "A案で進めて" });
    const previous = job({
      turnNumber: 2,
      instruction: "見出しの改善案を出して",
      assistantMessage: "A案は見出しを短くする変更です。",
      changedPaths: ["src/pages/index.astro"],
    });
    const other = [
      job({
        requestedBy: "other@example.com",
        turnNumber: 1,
        instruction: "other-owner",
      }),
      job({ siteId: "other-site", turnNumber: 1, instruction: "other-site" }),
      job({
        conversationId: "other-conversation",
        turnNumber: 1,
        instruction: "other-conversation",
      }),
      job({ turnNumber: 4, instruction: "future-turn" }),
      current,
    ];
    const history = [...other, previous];
    await classifyEditIntent(intentEnv as unknown as AppEnv, current, history);
    const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(JSON.parse(request.input)).toEqual({
      currentRequest: "A案で進めて",
      history: [
        {
          user: previous.instruction,
          assistant:
            previous.assistantMessage + "\n変更ファイル: src/pages/index.astro",
        },
      ],
    });
    expect(selectConversationJobs(current, history)).toEqual([previous]);
  });

  it("履歴を直近12ターンと文字予算へ限定する", () => {
    const current = job({ turnNumber: 20 });
    const history = Array.from({ length: 19 }, (_, index) =>
      job({
        turnNumber: index + 1,
        instruction: "短い依頼",
        assistantMessage: "短い回答",
      }),
    );
    expect(
      selectConversationJobs(current, history).map((turn) => turn.turnNumber),
    ).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(
      selectConversationJobs(
        current,
        history.map((turn) => ({
          ...turn,
          instruction: "x".repeat(4_000),
          assistantMessage: "x".repeat(4_000),
        })),
      ).map((turn) => turn.turnNumber),
    ).toEqual([17, 18, 19]);
  });

  it.each(["", "@cf/example/chat-model", "gpt-6-astra"])(
    "不正な判定モデル%sはAPI呼出し前に拒否する",
    async (model) => {
      await expect(
        classifyEditIntent(
          { ...intentEnv, CMS_AI_DECISIONS_MODEL: model } as unknown as AppEnv,
          job(),
          [],
        ),
      ).rejects.toThrow("モデル設定");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("Secrets Storeの詳細をエラーへ含めない", async () => {
    await expect(
      classifyEditIntent(
        {
          ...intentEnv,
          OPENAI_API_KEY_STORE: {
            get: async () => {
              throw new Error("private-secret-store-detail");
            },
          },
        } as unknown as AppEnv,
        job(),
        [],
      ),
    ).rejects.toThrow("OpenAI APIの設定がありません");
    expect(fetch).not.toHaveBeenCalled();
  });
});

function decisionResponse(choice: EditIntent) {
  return Response.json({
    answers: [{ name: "edit_intent", type: "choice", choice }],
  });
}

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
    instruction: "トップページの見出しを短くして",
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
