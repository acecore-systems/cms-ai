import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { format } from "prettier";
import { articleBody, portalFormat } from "./fixtures/seo-format.ts";
import { SeoRunner } from "../seo-runner/index.mjs";
import {
  acceptEditorialChange,
  assertFormattedSource,
  markdown,
  sourceIdentity,
} from "../src/seo-content.ts";
import { seoSite, SEO_LOCALES } from "../src/sites.ts";
import { sha256 } from "../src/seo-hash.ts";

const baseSha = "a".repeat(40),
  jobId = "00000000-0000-4000-8000-000000000001";
const runId = "editorial-00000000-0000-4000-8000-000000000002";
const sourcePath = "src/content/stories/example.md";
const source =
  "---\ntitle: Original\ndescription: Original description\ndate: 2026-08-08T10:00:00+09:00\nlastUpdated: 2026-10-09T15:00:00+09:00\nauthor: gui\nimage: /uploads/story.webp\n---\n\nOriginal body [reference](https://example.org/guide).\n" +
  articleBody;
const now = Date.parse("2026-10-19T00:00:00Z");
const candidate = {
  site: "portal",
  url: "https://asv.acecore.net/en/stories/example/",
  reason: "本文の改善",
};
let researchReference = false;
let reference = "https://example.org/new-guide";
let workspace: string,
  runner: SeoRunner,
  original: { path: string; content: string }[],
  request: ReturnType<typeof vi.fn>,
  execute: ReturnType<typeof vi.fn>,
  github: ReturnType<typeof vi.fn>,
  pushed: boolean;
beforeEach(async () => {
  researchReference = false;
  reference = "https://example.org/new-guide";
  const cache = join(process.cwd(), "node_modules", ".cache");
  await mkdir(cache, { recursive: true });
  workspace = await mkdtemp(join(cache, "seo-runner-test-"));
  const spec = seoSite("portal")!;
  original = [
    { path: sourcePath, content: source },
    ...SEO_LOCALES.map((locale) => ({
      path: "src/content/stories/" + locale + "/example.md",
      content: source.replace(
        "description:",
        "translationOf: example\nsourceHash: sha256:" +
          "a".repeat(64) +
          "\ndescription:",
      ),
    })),
  ];
  for (const file of [
    ...original,
    { path: "AGENTS.md", content: "# Guidelines\n" },
    ...spec.guidance.map((path) => ({
      path,
      content: "# Guide\n提供資料のみを使う。",
    })),
  ]) {
    await mkdir(join(workspace, file.path, ".."), { recursive: true });
    await writeFile(join(workspace, file.path), file.content);
  }
  const tracked = [
    ...original.map((file) => file.path),
    "AGENTS.md",
    ...spec.guidance,
  ];
  pushed = false;
  execute = vi.fn(
    async (
      command: string,
      args: string[],
      options: { env: Record<string, string> },
    ) => {
      if (command !== "git") {
        expect(options.env.GITHUB_TOKEN).toBeUndefined();
        expect(options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
      }
      if (command === "git" && args[0] === "push") pushed = true;
      const stdout =
        command === "git" && args[0] === "rev-parse"
          ? baseSha + "\n"
          : command === "git" && args[0] === "ls-files" && args[1] === "-z"
            ? tracked.join("\0") + "\0"
            : command === "git" &&
                args[0] === "diff" &&
                args[1] === "--name-only"
              ? original.map((file) => file.path).join("\0") + "\0"
              : "";
      return { stdout };
    },
  );
  runner = new SeoRunner({
    workspace,
    now: () => now,
    execute,
    env: {
      SEO_JOB_ID: jobId,
      SEO_RUN_ID: runId,
      GITHUB_REPOSITORY: spec.site.repository,
      GITHUB_TOKEN: "fixture-token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-oidc",
    },
  });
  vi.spyOn(runner, "format").mockImplementation(async (paths: string[]) => {
    for (const path of paths) {
      const file = await runner.read(path);
      await runner.write(
        {
          path,
          content: await format(file.content, portalFormat),
        },
        paths,
      );
    }
  });
  const identity = sourceIdentity("portal", candidate.url, original, now)!;
  let acceptedJapanese = "";
  request = vi.fn(
    async (
      operation = "",
      body?: { step?: number; japanese?: string; prUrl?: string },
    ) => {
      if (!operation)
        return {
          job: {
            id: jobId,
            runId,
            status: "inspecting",
            deadline: now + 20 * 60_000,
          },
          candidate,
          policy: { draftOnly: true, repository: spec.site.repository },
        };
      if (operation === "claim")
        return {
          status: "claimed",
          paths: original.map((file) => file.path),
          articleKey: identity.articleKey,
        };
      if (operation === "propose") {
        if (body!.step === 1)
          assertFormattedSource(acceptedJapanese, body!.japanese!);
        const file = original[body!.step!];
        const japanese =
          body!.step === 0 ? null : (await runner.read(sourcePath)).content;
        const content = await acceptEditorialChange(
          identity,
          file,
          {
            ...file,
            content:
              file.content.replaceAll("Original", "Revised") +
              (researchReference ? "\n[Reference](" + reference + ")\n" : ""),
          },
          japanese,
          now,
          researchReference ? [reference] : [],
        );
        if (body!.step === 0) acceptedJapanese = content;
        return {
          status: "proposal_created",
          file: { path: file.path, content },
          nextStep: body!.step! + 1,
        };
      }
      if (operation === "publish") return { status: "publishing" };
      if (operation === "finish")
        return { status: "draft_pr", prUrl: body!.prUrl };
      return { status: operation };
    },
  );
  vi.spyOn(runner, "request").mockImplementation(request);
  github = vi.fn(
    async (path: string, method?: string, body?: Record<string, unknown>) => {
      if (method === "POST") {
        expect(body?.draft).toBe(true);
        expect(pushed).toBe(true);
        return {
          draft: true,
          state: "open",
          number: 999,
          base: { sha: baseSha },
          head: { ref: "codex/seo-" + jobId },
          html_url:
            "https://github.com/acecore-systems/aceserver-portal/pull/999",
        };
      }
      if (path.includes("/files"))
        return [{ filename: "src/data/unrelated.json" }];
      return [{ number: 198 }];
    },
  );
  vi.spyOn(runner, "github").mockImplementation(github);
});
afterEach(async () => {
  vi.restoreAllMocks();
  // Fixed absolute fixture under this worktree; never remove a caller's directory.
  if (
    !workspace.startsWith(
      join(process.cwd(), "node_modules", ".cache", "seo-runner-test-"),
    )
  )
    throw new Error("fixture cleanup boundary");
  await rm(workspace, { recursive: true, force: true });
});

describe("SEO action runtime", () => {
  async function v2(referencePolicy = 1) {
    researchReference = true;
    const baseRequest = request.getMockImplementation()!;
    request.mockImplementation(async (operation = "", body: any) => {
      if (operation === "research")
        return {
          status: "researched",
          evidence: {
            version: 1,
            ...(referencePolicy === 2 ? { referencePolicy: 2 } : {}),
            checkedAt: new Date(now).toISOString(),
            sourceSha256: await sha256(source),
            sources: [{ url: reference }],
          },
        };
      if (operation === "review")
        return {
          status: "reviewed",
          receipt: {
            kind: "ai_review",
            filesSha256: await sha256(JSON.stringify(body.files)),
          },
        };
      const result = await baseRequest(operation, body);
      if (!operation) result.policy.protocolVersion = 2;
      return result;
    });
  }
  it("runs v2 fresh research and final nine-language AI review before publishing with the reviewed byte hash", async () => {
    await v2();
    expect((await runner.executeJob()).status).toBe("draft_pr");
    const operations = request.mock.calls.map(([op]) => op);
    expect(operations.indexOf("research")).toBeGreaterThan(
      operations.indexOf("claim"),
    );
    expect(operations.indexOf("research")).toBeLessThan(
      operations.indexOf("propose"),
    );
    expect(operations.indexOf("review")).toBeGreaterThan(
      operations.lastIndexOf("propose"),
    );
    expect(operations.indexOf("review")).toBeLessThan(
      operations.indexOf("publish"),
    );
    expect(
      (request.mock.calls.find(([op]) => op === "publish")![1] as any)
        .filesSha256,
    ).toMatch(/^[a-f0-9]{64}$/);
    const body = github.mock.calls.find(([, method]) => method === "POST")![2]!
      .body;
    expect(body).toContain("AI校閲ゲート通過");
    expect(body).toContain("人の母語話者校閲は未実施");
  });
  it("preserves the exact Learn view reference through nine-file validation, review and Draft body", async () => {
    reference =
      "https://learn.microsoft.com/en-us/minecraft/creator/documents/bedrockserver/getting-started?view=minecraft-bedrock-stable";
    await v2(2);
    expect((await runner.executeJob()).status).toBe("draft_pr");
    const body = github.mock.calls.find(([, method]) => method === "POST")![2]!
      .body;
    expect(body).toContain("<" + reference + ">");
  });
  it.each(["valid", "existing-pr", "existing-ref", "lost-callback", "unknown"])(
    "review rejection stays prepublication: %s",
    async (kind) => {
      await v2();
      const prior = request.getMockImplementation()!;
      request.mockImplementation(async (op = "", body: any) => {
        if (op === "review")
          return kind === "unknown"
            ? { status: "unresolved" }
            : { status: "review_failed", offerSha256: "b".repeat(64) };
        if (op === "review-reject")
          return {
            status: kind === "lost-callback" ? "unresolved" : "review_rejected",
            receiptSha256: "c".repeat(64),
          };
        const r = await prior(op, body);
        if (!op) r.policy.researchContract = 2;
        return r;
      });
      const priorGithub = github.getMockImplementation()!;
      github.mockImplementation(async (path, ...args) =>
        path.includes("state=all")
          ? kind === "existing-pr"
            ? [{ number: 1, state: "closed" }]
            : []
          : priorGithub(path, ...args),
      );
      const priorExecute = execute.getMockImplementation()!;
      execute.mockImplementation(async (command, args, ...rest) =>
        command === "git" &&
        args.includes("ls-remote") &&
        kind === "existing-ref" &&
        request.mock.calls.some((c) => c[0] === "review")
          ? { stdout: "existing-ref" }
          : priorExecute(command, args, ...rest),
      );
      const result = await runner.executeJob();
      expect(result.status).toBe(
        kind === "valid" ? "review_rejected" : "unresolved",
      );
      expect(request.mock.calls.filter((c) => c[0] === "propose")).toHaveLength(
        9,
      );
      expect(
        request.mock.calls.some((c) => ["publish", "finish"].includes(c[0])),
      ).toBe(false);
      expect(pushed).toBe(false);
      expect(github.mock.calls.some((c) => c[1] === "POST")).toBe(false);
    },
  );
  it("does not push or create a PR when research fails", async () => {
    await v2();
    const baseRequest = request.getMockImplementation()!;
    request.mockImplementation(async (op = "", body: any) =>
      op === "research" ? { status: "unresolved" } : baseRequest(op, body),
    );
    const result = await runner.executeJob();
    expect(result).toMatchObject({
      status: "unresolved",
      diagnostic: { stage: "research", code: "seo_research" },
    });
    expect(pushed).toBe(false);
    expect(request.mock.calls.some(([op]) => op === "propose")).toBe(false);
  });
  it("executes Japanese plus eight locales, validations and a confirmed Draft-only PR", async () => {
    expect(await runner.executeJob()).toEqual({
      status: "draft_pr",
      prUrl: "https://github.com/acecore-systems/aceserver-portal/pull/999",
    });
    const operations = request.mock.calls.map(([operation]) => operation);
    expect(
      operations.filter((operation) => operation === "propose"),
    ).toHaveLength(9);
    expect(operations.indexOf("claim")).toBeLessThan(
      operations.indexOf("propose"),
    );
    expect(operations.indexOf("publish")).toBeGreaterThan(
      operations.lastIndexOf("propose"),
    );
    const source = await readFile(join(workspace, sourcePath), "utf8");
    for (const file of original.slice(1))
      expect(
        markdown(await readFile(join(workspace, file.path), "utf8")).data
          .sourceHash,
      ).toBe("sha256:" + (await sha256(source)));
    const calls = execute.mock.calls;
    expect(
      calls.some(
        ([command, args]) =>
          command === "npm" && args.join(" ") === "run validate:i18n",
      ),
    ).toBe(true);
    expect(
      calls.some(
        ([command, args]) =>
          command === "git" &&
          args[0] === "add" &&
          args[1] === "--" &&
          args.includes(sourcePath),
      ),
    ).toBe(true);
    expect(
      calls.some(
        ([, args]) =>
          args.includes("--force") ||
          args.includes("--merge") ||
          args.includes("--auto"),
      ),
    ).toBe(false);
    const creation = github.mock.calls.find(([, method]) => method === "POST")!;
    expect(creation[2]?.body).toContain(
      "外部再調査未実施、既存本文に基づく構成・表現改善",
    );
    expect(creation[2]?.body).not.toContain("fixture-token");
  });
  it("skips a candidate with an overlapping open PR before any claim/model call", async () => {
    github.mockImplementation(async (path) =>
      path.includes("/files") ? [{ filename: sourcePath }] : [{ number: 134 }],
    );
    expect(await runner.executeJob()).toEqual({ status: "skipped" });
    expect(request.mock.calls.map(([operation]) => operation)).toEqual([
      undefined,
      "skip",
    ]);
    expect(pushed).toBe(false);
  });
  it("retains unknown state if an API result/partial translation is lost, without pushing", async () => {
    const normal = request.getMockImplementation()!;
    request.mockImplementation(async (operation, body) =>
      operation === "propose" && body?.step === 3
        ? { status: "unresolved" }
        : normal(operation, body),
    );
    expect(await runner.executeJob()).toEqual({
      status: "unresolved",
      diagnostic: { stage: "propose", code: "seo_generation" },
    });
    expect(request.mock.calls.at(-1)?.[0]).toBe("unresolved");
    expect(
      request.mock.calls.some(([operation]) => operation === "publish"),
    ).toBe(false);
    expect(pushed).toBe(false);
  });
  it.each([
    ["validate:content", "validate_content"],
    ["build", "build"],
  ])(
    "reports only a fixed stage/code on %s failure and never publishes",
    async (script, stage) => {
      const normal = execute.getMockImplementation()!;
      execute.mockImplementation(async (command, args, options) => {
        if (command === "npm" && args.includes(script))
          throw Object.assign(new Error("private source and fixture-token"), {
            stdout: "private article content",
            stderr: "fixture-oidc",
          });
        return normal(command, args, options);
      });
      expect(await runner.executeJob()).toEqual({
        status: "unresolved",
        diagnostic: { stage, code: "seo_command_failed" },
      });
      expect(request.mock.calls.at(-1)).toEqual(["unresolved", {}, true]);
      expect(
        request.mock.calls.some(([operation]) => operation === "publish"),
      ).toBe(false);
      expect(pushed).toBe(false);
      expect(github.mock.calls.some(([, method]) => method === "POST")).toBe(
        false,
      );
    },
  );
  it("stops when latest main changes", async () => {
    let reads = 0;
    const normal = execute.getMockImplementation()!;
    execute.mockImplementation(async (command, args, options) => {
      if (
        command === "git" &&
        args[0] === "rev-parse" &&
        args[1] === "refs/remotes/origin/main" &&
        ++reads > 2
      )
        return { stdout: "b".repeat(40) };
      return normal(command, args, options);
    });
    expect(await runner.executeJob()).toMatchObject({
      status: "unresolved",
      diagnostic: { code: "seo_main_changed" },
    });
    expect(pushed).toBe(false);
  });
  it("does not replay PR creation after a lost GitHub response", async () => {
    const normal = github.getMockImplementation()!;
    github.mockImplementation(async (path, method, body) => {
      if (method === "POST") throw new Error("lost response");
      return normal(path, method, body);
    });
    expect(await runner.executeJob()).toEqual({
      status: "unresolved",
      diagnostic: { stage: "draft_pr", code: "unexpected_error" },
    });
    expect(pushed).toBe(true);
    expect(
      github.mock.calls.filter(([, method]) => method === "POST"),
    ).toHaveLength(1);
    expect(request.mock.calls.at(-1)?.[0]).toBe("unresolved");
  });
  it("redacts unknown errors/stages and preserves the first failure across a lost callback", async () => {
    vi.spyOn(runner, "run").mockImplementation(async () => {
      runner.active = true;
      runner.stage = "private dynamic stage";
      throw new Error("seo_command_failed:private source or token");
    });
    request.mockImplementation(async () => {
      runner.stage = "finish";
      throw new Error("seo_completion_unknown");
    });
    expect(await runner.executeJob()).toEqual({
      status: "unresolved",
      diagnostic: { stage: "unknown", code: "unexpected_error" },
    });
    expect(request.mock.calls).toEqual([["unresolved", {}, true]]);
    expect(execute).not.toHaveBeenCalled();
    expect(github).not.toHaveBeenCalled();
  });
  it("blocks traversal and junctions before reading or replacing source", async () => {
    await expect(runner.read("../outside.md")).rejects.toThrow("seo_path");
    await mkdir(join(workspace, "other"));
    await symlink(
      join(workspace, "other"),
      join(workspace, "link"),
      "junction",
    );
    await expect(runner.safePath("link/example.md")).rejects.toThrow(
      "seo_symlink",
    );
  });
  it("treats incomplete GitHub pagination as unknown, not absence of overlapping PRs", async () => {
    github.mockResolvedValue(
      Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })),
    );
    await expect(runner.pageAll("/pulls?state=open")).rejects.toThrow(
      "seo_github_list_incomplete",
    );
    expect(github).toHaveBeenCalledTimes(10);
  });
});

it.each([false, true])(
  "checks all-state PR absence before terminal rejection (PR exists=%s)",
  async (exists) => {
    const prior = request.getMockImplementation()!;
    request.mockImplementation(async (operation = "", body) => {
      if (!operation) {
        const data = await prior(operation, body);
        data.policy.protocolVersion = 2;
        data.policy.researchContract = 2;
        return data;
      }
      if (operation === "research")
        return { status: "research_insufficient", offerSha256: "b".repeat(64) };
      if (operation === "research-reject") {
        expect(body).toEqual({
          baseSha,
          offerSha256: "b".repeat(64),
          refs: [],
          pullRequests: [],
        });
        return { status: "research_rejected", receiptSha256: "c".repeat(64) };
      }
      return prior(operation, body);
    });
    const priorGithub = github.getMockImplementation()!;
    github.mockImplementation(async (path, ...args) =>
      path.includes("state=all")
        ? exists
          ? [{ number: 1, state: "closed" }]
          : []
        : priorGithub(path, ...args),
    );
    const result = await runner.executeJob();
    expect(result.status).toBe(exists ? "unresolved" : "research_rejected");
    expect(
      request.mock.calls.some((c) =>
        ["propose", "publish", "finish"].includes(c[0]),
      ),
    ).toBe(false);
    expect(request.mock.calls.some((c) => c[0] === "research-reject")).toBe(
      !exists,
    );
    expect(pushed).toBe(false);
    expect(github.mock.calls.some((c) => c[1] === "POST")).toBe(false);
  },
);

it.each([
  [1, 150000],
  [2, 510000],
])(
  "pins generation %i RPC timeout and keeps the root deadline",
  async (version, maximum) => {
    const r = new SeoRunner({
      now: () => now,
      env: {
        SEO_JOB_ID: jobId,
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.test/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture",
      },
      fetch: async (url: string) =>
        new Response(
          JSON.stringify(
            String(url).includes("token")
              ? { value: "oidc" }
              : { status: "unresolved" },
          ),
          { status: 200 },
        ),
    });
    r.generationOutput = version;
    r.deadline = now + 1000000;
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await r.request("propose", { step: 0 });
    expect(timeout).toHaveBeenLastCalledWith(maximum);
    r.deadline = now + 10000;
    await r.request("propose", { step: 0 });
    expect(timeout).toHaveBeenLastCalledWith(10000);
  },
);
