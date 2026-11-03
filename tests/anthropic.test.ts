import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anthropicPayload,
  HAIKU_MODEL,
  runAnthropic,
} from "../src/anthropic.ts";
import type { AppEnv } from "../src/env.ts";

const request = {
  messages: [
    { role: "system", content: "system" },
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
      ],
    },
  ],
  max_completion_tokens: 12000,
  reasoning_effort: "medium",
  response_format: {
    type: "json_schema",
    json_schema: {
      type: "object",
      properties: {
        items: { type: "array", maxItems: 20, items: { type: "string" } },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
};
const response = {
  type: "message",
  role: "assistant",
  model: HAIKU_MODEL,
  stop_reason: "end_turn",
  content: [
    { type: "thinking", thinking: "private" },
    { type: "text", text: '{"items":[]}' },
  ],
};
afterEach(() => vi.unstubAllGlobals());

describe("Anthropic CMS adapter", () => {
  it("maps system, image, effort, and supported schema", () => {
    expect(anthropicPayload(request)).toEqual({
      model: HAIKU_MODEL,
      system: "system",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "YQ==" },
            },
          ],
        },
      ],
      max_tokens: 12000,
      output_config: {
        effort: "medium",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { items: { type: "array", items: { type: "string" } } },
            required: ["items"],
            additionalProperties: false,
          },
        },
      },
    });
  });
  it("sends a single authenticated request and returns only the answer", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal("fetch", fetcher);
    expect(
      await runAnthropic({ ANTHROPIC_API_KEY: "test" } as AppEnv, request),
    ).toEqual({
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: '{"items":[]}' },
        },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    expect(fetcher.mock.calls[0][1].headers["anthropic-version"]).toBe(
      "2023-06-01",
    );
  });
  it.each([
    { ...response, stop_reason: "max_tokens" },
    { ...response, stop_reason: "refusal" },
    { ...response, content: [{ type: "tool_use" }] },
    { ...response, content: [] },
  ])(
    "rejects incomplete, refused or unexpected replies without retry",
    async (body) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(body)));
      vi.stubGlobal("fetch", fetcher);
      await expect(
        runAnthropic({ ANTHROPIC_API_KEY: "test" } as AppEnv, request),
      ).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects missing credentials before network access", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(runAnthropic({} as AppEnv, request)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
