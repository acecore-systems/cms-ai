import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { getJob } from "../src/db.ts";
import type { AppEnv } from "../src/env.ts";
import { runInference } from "../src/inference.ts";
import { getSiteById } from "../src/sites.ts";
import { handleUserRequest, readMessageInput } from "../src/user.ts";

vi.mock("../src/auth.ts", () => ({
  authenticateSiteRequest: async () => ({
    email: "editor@example.com",
    site: getSiteById("homepage-hatt"),
    membership: { role: "editor" },
  }),
}));
vi.mock("../src/github.ts", () => ({ dispatchCmsAiJob: async () => {} }));

afterEach(() => vi.unstubAllGlobals());

it("additive D1 migration preserves old jobs and carries each new effort from message to provider", async () => {
  const m = await import("miniflare");
  const options = {
    modules: true,
    script: "export default {fetch(){return new Response(null)}}",
    compatibilityDate: "2026-09-01",
    d1Databases: ["DB"],
  };
  const mf = new m.Miniflare(
    (m as any).convertV4MiniflareOptions
      ? (m as any).convertV4MiniflareOptions(options)
      : options,
  );
  try {
    const db = await mf.getD1Database("DB");
    for (const name of [
      "0001_initial.sql",
      "0002_image_attachments.sql",
      "0003_max_reasoning_effort.sql",
    ]) {
      await db.exec(
        readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8")
          .replace(/--[^\n]*/g, "")
          .replace(/\s+/g, " "),
      );
    }
    await db
      .prepare(
        "INSERT INTO cms_ai_jobs(id,site_id,conversation_id,turn_number,requested_by,requested_role,instruction,reasoning_effort,status,branch_name,created_at,updated_at,attachments_json) VALUES('old','homepage-hatt','old-c',1,'editor@example.com','editor','old','max','responded','branch','old-time','old-time',?)",
      )
      .bind('[{"id":"image"}]')
      .run();
    const before = await db
      .prepare("SELECT * FROM cms_ai_jobs WHERE id='old'")
      .first();
    const indexes = (
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cms_ai_jobs' ORDER BY name",
        )
        .all()
    ).results;
    await db.exec(
      readFileSync(
        new URL("../migrations/0050_cms_muse_effort.sql", import.meta.url),
        "utf8",
      )
        .replace(/--[^\n]*/g, "")
        .replace(/\s+/g, " "),
    );
    await db
      .prepare(
        "INSERT INTO cms_ai_jobs(id,site_id,conversation_id,turn_number,requested_by,requested_role,instruction,reasoning_effort,status,branch_name,created_at,updated_at) VALUES('old-worker','homepage-hatt','old-worker-c',1,'editor@example.com','editor','old','high','queued','branch','old-time','old-time')",
      )
      .run();
    expect(
      await db
        .prepare(
          "SELECT reasoning_effort,muse_reasoning_effort FROM cms_ai_jobs WHERE id='old-worker'",
        )
        .first(),
    ).toEqual({ reasoning_effort: "high", muse_reasoning_effort: null });
    const after = await db
      .prepare("SELECT * FROM cms_ai_jobs WHERE id='old'")
      .first();
    expect(after).toEqual({ ...before, muse_reasoning_effort: null });
    expect(
      (
        await db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cms_ai_jobs' ORDER BY name",
          )
          .all()
      ).results,
    ).toEqual(indexes);
    const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
      Response.json({
        model: "muse-ember-1.0",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                summary: "ok",
                clarification: "",
                changes: [],
              }),
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const env = {
      CMS_AI_DB: db,
      CMS_AI_MODEL: "muse-ember-1.0",
      META_API_KEY_STORE: { get: async () => "fixture" },
    } as unknown as AppEnv;
    const site = getSiteById("homepage-hatt")!;
    for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
      const response = await handleUserRequest(
        new Request("https://example.test/admin/api/ai/jobs", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://example.test",
          },
          body: JSON.stringify({
            instruction: "test",
            reasoningEffort: effort,
          }),
        }),
        env,
      );
      expect(response.status).toBe(202);
      const created = (
        (await response.json()) as {
          job: { id: string; reasoningEffort: string };
        }
      ).job;
      expect(created.reasoningEffort).toBe(effort);
      const saved = (await getJob(env, created.id))!;
      expect(saved.reasoningEffort).toBe(effort);
      const compatible = await db
        .prepare(
          "SELECT reasoning_effort,muse_reasoning_effort FROM cms_ai_jobs WHERE id=?",
        )
        .bind(created.id)
        .first();
      expect(compatible).toEqual({
        reasoning_effort:
          effort === "minimal" ? "low" : effort === "xhigh" ? "high" : effort,
        muse_reasoning_effort: ["minimal", "xhigh"].includes(effort)
          ? effort
          : null,
      });
      await runInference(
        env,
        site,
        saved,
        [{ path: "src/pages/index.astro", content: "<main />" }],
        [],
      );
      expect(
        JSON.parse(String(fetcher.mock.calls.at(-1)![1].body)).reasoning_effort,
      ).toBe(effort);
    }
    await expect(
      readMessageInput(
        new Request("https://example.test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instruction: "test",
            reasoningEffort: "none",
          }),
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "UPDATE cms_ai_jobs SET muse_reasoning_effort='minimal',reasoning_effort='high' WHERE id='old'",
        )
        .run(),
    ).rejects.toThrow();
  } finally {
    await mf.dispose();
  }
}, 30000);
