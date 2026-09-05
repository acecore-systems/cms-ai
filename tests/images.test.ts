import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  boundedRequest,
  imageContent,
  imageKey,
  MAX_MESSAGE_BYTES,
  storeImages,
  validateImages,
} from "../src/images.ts";
import { handleUserRequest, readMessageInput } from "../src/user.ts";
import { authenticateSiteRequest } from "../src/auth.ts";
import { getJob } from "../src/db.ts";
import type { AppEnv } from "../src/env.ts";
import type { Job } from "../src/models.ts";

vi.mock("../src/auth.ts", () => ({ authenticateSiteRequest: vi.fn() }));
vi.mock("../src/db.ts", () => ({
  getJob: vi.fn(),
  createJob: vi.fn(),
  getConversation: vi.fn(),
  listConversations: vi.fn(),
  updateJob: vi.fn(),
}));
const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII=",
    "base64",
  ),
);
const file = () => new File([png], "参考.png", { type: "image/png" });
const base = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  siteId: "homepage-hatt",
  requestedBy: "owner@example.com",
};

describe("private image messages", () => {
  beforeEach(() => vi.clearAllMocks());
  it("multipart画像のみとeffortを受け付ける", async () => {
    const form = new FormData();
    form.append("images", file());
    form.append("reasoningEffort", "high");
    const input = await readMessageInput(
      new Request("https://site.test/", { method: "POST", body: form }),
    );
    expect(input.images).toHaveLength(1);
    expect(input.reasoningEffort).toBe("high");
    expect(input.instruction).toMatch(/添付画像/);
  });
  it("画像なしの既存JSONリクエストも受け付ける", async () => {
    const input = await readMessageInput(
      new Request("https://site.test/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: "相談です" }),
      }),
    );
    expect(input.images).toEqual([]);
    expect(input.instruction).toBe("相談です");
  });
  it("SVG、偽装mime、過大画像、枚数超過を拒否する", async () => {
    await expect(
      validateImages([
        new File(["<svg>bad</svg>"], "x.png", { type: "image/png" }),
      ]),
    ).rejects.toThrow(/PNG/);
    await expect(
      validateImages([new File([png], "x.jpg", { type: "image/jpeg" })]),
    ).rejects.toThrow(/PNG/);
    await expect(
      validateImages([
        new File([new Uint8Array(2 * 1024 * 1024 + 1)], "x.png", {
          type: "image/png",
        }),
      ]),
    ).rejects.toThrow(/2MB/);
    await expect(
      validateImages(Array.from({ length: 5 }, file)),
    ).rejects.toThrow(/4枚/);
  });
  it("画像URLの指定を拒否する", async () => {
    const form = new FormData();
    form.append("instruction", "相談");
    form.append("images", "https://internal.test/secret");
    await expect(
      readMessageInput(
        new Request("https://site.test/", { method: "POST", body: form }),
      ),
    ).rejects.toThrow(/URL/);
  });
  it("Content-Lengthなしでも読み込み中に上限を強制する", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(MAX_MESSAGE_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://site.test/", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expect(boundedRequest(request)).rejects.toThrow(/大きすぎ/);
    expect(cancelled).toBe(true);
  });
  it("保存途中の失敗は添付オブジェクトだけを掃除する", async () => {
    const images = await validateImages([file(), file()]);
    const bucket = {
      put: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error("failure")),
      delete: vi.fn(),
    };
    await expect(
      storeImages(
        { CMS_AI_IMAGES: bucket } as unknown as AppEnv,
        base.id,
        images,
      ),
    ).rejects.toThrow(/保存/);
    expect(bucket.delete).toHaveBeenCalledWith(
      images.map((i) => imageKey(base.id, i.attachment.id)),
    );
  });
  it("data URLをモデルへ渡し、履歴画像の予算を強制する", async () => {
    const [uploaded] = await validateImages([file()]);
    const bucket = {
      get: vi.fn().mockResolvedValue({
        size: png.length,
        arrayBuffer: async () => png.buffer,
      }),
    };
    const env = { CMS_AI_IMAGES: bucket } as unknown as AppEnv;
    const job = { ...base, attachments: [uploaded.attachment] } as Job;
    const content = await imageContent(env, job, "この画像", {
      remaining: png.length,
    });
    expect(content).toEqual([
      { type: "text", text: "この画像" },
      {
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
        },
      },
    ]);
    const omitted = await imageContent(env, job, "前回", { remaining: 0 });
    expect(JSON.stringify(omitted)).toContain("省略");
    expect(bucket.get).toHaveBeenCalledTimes(1);
  });
  it.each(["other-user", "other-site", "revoked"])(
    "%sは画像取得できずR2を読まない",
    async (kind) => {
      const [uploaded] = await validateImages([file()]);
      vi.mocked(getJob).mockResolvedValue({
        ...base,
        attachments: [uploaded.attachment],
      } as Job);
      const identity = {
        email: kind === "other-user" ? "other@example.com" : base.requestedBy,
        site: { id: kind === "other-site" ? "homepage-cherry" : base.siteId },
      };
      if (kind === "revoked")
        vi.mocked(authenticateSiteRequest).mockRejectedValue(
          new Error("revoked"),
        );
      else
        vi.mocked(authenticateSiteRequest).mockResolvedValue(
          identity as Awaited<ReturnType<typeof authenticateSiteRequest>>,
        );
      const get = vi.fn();
      await expect(
        handleUserRequest(
          new Request(
            `https://site.test/admin/api/ai/jobs/${base.id}/images/${uploaded.attachment.id}`,
          ),
          { CMS_AI_IMAGES: { get } } as unknown as AppEnv,
        ),
      ).rejects.toThrow();
      expect(get).not.toHaveBeenCalled();
    },
  );
  it("所有者へno-store・nosniffで配信する", async () => {
    const [uploaded] = await validateImages([file()]);
    vi.mocked(getJob).mockResolvedValue({
      ...base,
      attachments: [uploaded.attachment],
    } as Job);
    vi.mocked(authenticateSiteRequest).mockResolvedValue({
      email: base.requestedBy,
      site: { id: base.siteId },
    } as Awaited<ReturnType<typeof authenticateSiteRequest>>);
    const get = vi.fn().mockResolvedValue({ body: png, size: png.length });
    const response = await handleUserRequest(
      new Request(
        `https://site.test/admin/api/ai/jobs/${base.id}/images/${uploaded.attachment.id}`,
      ),
      { CMS_AI_IMAGES: { get } } as unknown as AppEnv,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  });
});
