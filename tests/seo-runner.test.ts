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
let workspace: string,
  runner: SeoRunner,
  original: { path: string; content: string }[],
  request: ReturnType<typeof vi.fn>,
  execute: ReturnType<typeof vi.fn>,
  github: ReturnType<typeof vi.fn>,
  pushed: boolean;
beforeEach(async () => {
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
          { ...file, content: file.content.replaceAll("Original", "Revised") },
          japanese,
          now,
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
    expect(await runner.executeJob()).toEqual({ status: "unresolved" });
    expect(request.mock.calls.at(-1)?.[0]).toBe("unresolved");
    expect(
      request.mock.calls.some(([operation]) => operation === "publish"),
    ).toBe(false);
    expect(pushed).toBe(false);
  });
  it("does not push or create a PR on target validation failure", async () => {
    const normal = execute.getMockImplementation()!;
    execute.mockImplementation(async (command, args, options) => {
      if (command === "npm" && args.includes("build"))
        throw new Error("private build output");
      return normal(command, args, options);
    });
    expect(await runner.executeJob()).toEqual({ status: "unresolved" });
    expect(pushed).toBe(false);
    expect(github.mock.calls.some(([, method]) => method === "POST")).toBe(
      false,
    );
  });
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
    expect(await runner.executeJob()).toEqual({ status: "unresolved" });
    expect(pushed).toBe(false);
  });
  it("does not replay PR creation after a lost GitHub response", async () => {
    const normal = github.getMockImplementation()!;
    github.mockImplementation(async (path, method, body) => {
      if (method === "POST") throw new Error("lost response");
      return normal(path, method, body);
    });
    expect(await runner.executeJob()).toEqual({ status: "unresolved" });
    expect(pushed).toBe(true);
    expect(
      github.mock.calls.filter(([, method]) => method === "POST"),
    ).toHaveLength(1);
    expect(request.mock.calls.at(-1)?.[0]).toBe("unresolved");
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
