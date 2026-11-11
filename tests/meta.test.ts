import { afterEach, expect, it, vi } from "vitest";
import { metaPayload, MUSE_MODEL, runMeta } from "../src/meta.ts";
import type { AppEnv } from "../src/env.ts";

const schema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
};
const request = {
  messages: [
    { role: "system", content: "system" },
    {
      role: "user",
      content: [
        { type: "text", text: "test" },
        { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
      ],
    },
  ],
  max_completion_tokens: 12000,
  reasoning_effort: "high",
  response_format: { type: "json_schema", json_schema: schema },
};
afterEach(() => vi.unstubAllGlobals());

it("pins the Meta model, effort, image, and strict schema", () => {
  expect(metaPayload(request)).toEqual({
    model: MUSE_MODEL,
    messages: request.messages,
    max_completion_tokens: 12000,
    reasoning_effort: "medium",
    store: false,
    response_format: {
      type: "json_schema",
      json_schema: { name: "cms_ai_changes", schema, strict: true },
    },
  });
});

it("uses the fixed endpoint and refuses unexpected models or truncation", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: MUSE_MODEL,
          choices: [
            { finish_reason: "stop", message: { content: '{"value":"ok"}' } },
          ],
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: MUSE_MODEL,
          choices: [{ finish_reason: "length", message: { content: "{}" } }],
        }),
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  const env = { META_API_KEY_STORE: { get: async () => "test-key" } } as AppEnv;
  await runMeta(env, request);
  expect(fetcher.mock.calls[0][0]).toBe(
    "https://api.meta.ai/v1/chat/completions",
  );
  expect(fetcher.mock.calls[0][1].redirect).toBe("manual");
  await expect(runMeta(env, request)).rejects.toThrow("meta_response_invalid");
});
