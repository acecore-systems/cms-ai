import { SEO_RESEARCH_RPC_MS } from "../src/seo-time-bounds.ts";
import { hasPendingSeoRevision } from "../src/seo-translation-pending.ts";
import { evidenceReferences, referenceUrl } from "../src/seo-evidence.ts";
import { execFile } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { seoSite, seoArticleUrl, SEO_RUNNER_AUDIENCE } from "../src/sites.ts";
import {
  sourceIdentity,
  markdown,
  normalizeLf,
  assertEditorialFiles,
} from "../src/seo-content.ts";

const exec = promisify(execFile);
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

const validationStages = Object.freeze({
  "format:check": "validate_format",
  "validate:content": "validate_content",
  "validate:i18n": "validate_i18n",
  "validate:seo": "validate_seo",
  "test:cms": "test_cms",
  "typecheck:functions": "typecheck_functions",
  "validate:blog-freshness": "validate_freshness",
  build: "build",
  check: "check",
});
const diagnosticStages = new Set([
  "setup",
  "inspect",
  "claim",
  "research",
  "review",
  "propose",
  "format_japanese",
  "format_all",
  "final_assertion",
  "translation_state",
  "validation",
  "diff",
  "commit",
  "publish",
  "push",
  "draft_pr",
  "finish",
  ...Object.values(validationStages),
]);
const diagnosticCodes = new Set([
  "seo_command_failed",
  "seo_deadline",
  "seo_rpc",
  "seo_research",
  "seo_review",
  "seo_generation",
  "seo_main_changed",
  "seo_translation_hash",
  "seo_immutable_metadata",
  "seo_update_date",
  "seo_no_copy_change",
  "seo_locale_missing",
  "seo_unexpected_diff",
  "seo_pull_request_overlap",
  "seo_validation_changed_source",
  "seo_publish",
  "seo_draft_confirmation",
  "seo_completion_unknown",
  "seo_github_response",
  "seo_path",
  "seo_symlink",
]);

// Dependencies are injectable for runtime tests; the action always uses the real
// filesystem, signed OIDC and GitHub API, with no model credentials on the runner.
export class SeoRunner {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.workspace = resolve(
      options.workspace || this.env.GITHUB_WORKSPACE || process.cwd(),
    );
    this.jobId = this.env.SEO_JOB_ID || "";
    this.runId = this.env.SEO_RUN_ID || "";
    this.repository = this.env.GITHUB_REPOSITORY || "";
    this.fetch = options.fetch || globalThis.fetch;
    this.execute = options.execute || exec;
    this.now = options.now || Date.now;
    this.deadline = null;
    this.active = false;
    this.packageDirectory = null;
    this.validationCommands = [];
    this.stage = "setup";
  }
  remaining(report = false) {
    const remaining =
      this.deadline === null || report ? 30_000 : this.deadline - this.now();
    if (remaining <= 0) throw new Error("seo_deadline");
    return remaining;
  }
  async request(operation = "", body, report = false) {
    const base = (this.env.SEO_RUNNER_URL || SEO_RUNNER_AUDIENCE).replace(
      /\/$/,
      "",
    );
    const audience = this.env.SEO_RUNNER_AUDIENCE || SEO_RUNNER_AUDIENCE;
    if (base !== SEO_RUNNER_AUDIENCE || audience !== SEO_RUNNER_AUDIENCE)
      throw new Error("seo_endpoint");
    const endpoint = new URL(this.env.ACTIONS_ID_TOKEN_REQUEST_URL || "");
    if (
      endpoint.protocol !== "https:" ||
      !this.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    )
      throw new Error("seo_oidc");
    endpoint.searchParams.set("audience", audience);
    const tokenResponse = await this.fetch(endpoint, {
      headers: {
        Authorization: "Bearer " + this.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
      },
      signal: AbortSignal.timeout(Math.min(30_000, this.remaining(report))),
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || typeof token.value !== "string")
      throw new Error("seo_oidc");
    const response = await this.fetch(
      base + "/jobs/" + this.jobId + (operation ? "/" + operation : ""),
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: "Bearer " + token.value,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(
          Math.min(
            operation === "research" && this.editorialScope === 2
              ? SEO_RESEARCH_RPC_MS
              : (operation === "propose" && this.generationOutput === 2) ||
                  (operation === "review" && this.editorialScope === 2)
                ? 510_000
                : ["propose", "research", "review"].includes(operation)
                  ? 150_000
                  : 30_000,
            this.remaining(report),
          ),
        ),
      },
    );
    if (!response.ok) throw new Error("seo_rpc");
    return response.json();
  }
  async command(command, args, options = {}) {
    const env = { ...this.env, CI: "true", GIT_TERMINAL_PROMPT: "0" };
    for (const name of [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      "ACTIONS_ID_TOKEN_REQUEST_URL",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
    ])
      delete env[name];
    if (command === "git") {
      if (!this.env.GITHUB_TOKEN) throw new Error("seo_github_token");
      Object.assign(env, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0:
          "AUTHORIZATION: basic " +
          Buffer.from("x-access-token:" + this.env.GITHUB_TOKEN).toString(
            "base64",
          ),
      });
    }
    try {
      const result = await this.execute(command, args, {
        cwd: options.cwd || this.workspace,
        env,
        timeout: Math.min(options.timeout || 10 * 60_000, this.remaining()),
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
      return String(result.stdout || "");
    } catch {
      // Never include command output: build/provider/git errors may contain source or tokens.
      throw new Error("seo_command_failed");
    }
  }
  async github(path, method = "GET", body) {
    const response = await this.fetch(
      "https://api.github.com/repos/" + this.repository + path,
      {
        method,
        headers: {
          Authorization: "Bearer " + this.env.GITHUB_TOKEN,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(Math.min(30_000, this.remaining())),
      },
    );
    if (!response.ok) throw new Error("seo_github_response");
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024)
      throw new Error("seo_github_response_size");
    return JSON.parse(text);
  }
  async pageAll(path) {
    const values = [];
    for (let page = 1; page <= 10; page++) {
      const data = await this.github(
        path + (path.includes("?") ? "&" : "?") + "per_page=100&page=" + page,
      );
      if (!Array.isArray(data)) throw new Error("seo_github_list");
      values.push(...data);
      if (data.length < 100) return values;
    }
    throw new Error("seo_github_list_incomplete");
  }
  async overlapping(paths) {
    const prs = await this.pageAll("/pulls?state=open");
    for (const pr of prs) {
      if (!Number.isSafeInteger(pr.number)) throw new Error("seo_pull_request");
      const files = await this.pageAll("/pulls/" + pr.number + "/files");
      if (
        files.some(
          (file) =>
            paths.includes(file.filename) ||
            paths.includes(file.previous_filename),
        )
      )
        return true;
    }
    return false;
  }
  async latestMain(baseSha) {
    await this.command("git", ["fetch", "--no-tags", "origin", "main"]);
    const latest = (
      await this.command("git", ["rev-parse", "refs/remotes/origin/main"])
    ).trim();
    if (!/^[a-f0-9]{40}$/.test(latest) || (baseSha && latest !== baseSha))
      throw new Error("seo_main_changed");
    return latest;
  }
  async safePath(path) {
    if (
      typeof path !== "string" ||
      !path ||
      path.includes("\\") ||
      path.includes(":") ||
      path
        .split("/")
        .some(
          (part) =>
            !part || part === "." || part === ".." || part.startsWith("."),
        )
    )
      throw new Error("seo_path");
    const absolute = resolve(this.workspace, path);
    if (!absolute.startsWith(this.workspace + sep)) throw new Error("seo_path");
    const parts = path.split("/");
    let current = this.workspace;
    for (const part of parts) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("seo_symlink");
    }
    return absolute;
  }
  async read(path) {
    const absolute = await this.safePath(path);
    const stats = await lstat(absolute);
    if (!stats.isFile() || stats.size > 128 * 1024)
      throw new Error("seo_file_size");
    const content = normalizeLf(await readFile(absolute, "utf8"));
    if (content.includes("\0")) throw new Error("seo_binary");
    return { path, content };
  }
  async write(file, paths) {
    if (
      !paths.includes(file.path) ||
      typeof file.content !== "string" ||
      Buffer.byteLength(file.content) > 128 * 1024
    )
      throw new Error("seo_change");
    await writeFile(
      await this.safePath(file.path),
      normalizeLf(file.content),
      "utf8",
    );
  }
  async format(paths, spec) {
    // Wiki has no formatter contract. Other sites use their installed Prettier/config.
    if (spec.key === "wiki") return;
    const root = resolve(this.workspace, spec.site.packageDirectory);
    const require = createRequire(join(root, "package.json"));
    const cli = require.resolve("prettier/bin/prettier.cjs");
    await this.command(
      process.execPath,
      [
        cli,
        "--write",
        "--",
        ...paths.map((path) => relative(root, resolve(this.workspace, path))),
      ],
      { cwd: root },
    );
  }
  async collect(candidate, tracked) {
    const target = seoArticleUrl(candidate.site, candidate.url);
    if (!target) return null;
    const possible = tracked.filter(
      (path) =>
        path.startsWith(target.directory + "/") &&
        !path.slice(target.directory.length + 1).includes("/") &&
        path.endsWith(".md"),
    );
    const roots = [];
    for (const path of possible) {
      if (
        !target.spec.slugField &&
        path !== target.directory + "/" + target.slug + ".md"
      )
        continue;
      roots.push(await this.read(path));
    }
    const selected = roots.find((file) =>
      target.spec.slugField
        ? markdown(file.content).data[target.spec.slugField] === target.slug
        : true,
    );
    if (!selected) return null;
    if (
      this.editorialScope === 2 &&
      target.spec.translationStaging &&
      tracked.includes(target.spec.translationStaging.manifest) &&
      (await hasPendingSeoRevision(
        target.spec,
        selected,
        (await this.read(target.spec.translationStaging.manifest)).content,
        async (path) => (await this.read(path)).content,
      ))
    )
      return null;
    const filename = selected.path.slice(target.directory.length + 1);
    const files = [selected];
    for (const locale of this.editorialScope === 2 ? [] : target.spec.locales) {
      const path = target.directory + "/" + locale + "/" + filename;
      if (!tracked.includes(path)) return null;
      files.push(await this.read(path));
    }
    if (this.editorialScope !== 2 && target.spec.statePath) {
      const state = JSON.parse(
        (await this.read(target.spec.statePath)).content,
      );
      if (state.pendingInsights?.[target.slug]) return null;
    }
    // Read guidance from the actual checkout. Only repository-relative docs are sent
    // as source context; credentials, GitHub config and arbitrary linked URLs are not read.
    const agent = await this.read("AGENTS.md");
    const guides = new Set(target.spec.guidance);
    for (const match of agent.content.matchAll(
      /\]\((docs\/[^)#]+\.md)(?:#[^)]*)?\)/gu,
    ))
      guides.add(match[1]);
    for (const path of guides) {
      if (!tracked.includes(path)) throw new Error("seo_guidance_missing");
      files.push(await this.read(path));
    }
    if (target.spec.key === "wiki") {
      await this.read("README.md");
      await this.read("poc/astro-sveltia/README.md");
    }
    const identity = sourceIdentity(
      candidate.site,
      candidate.url,
      files,
      this.now(),
      this.editorialScope ?? 1,
    );
    if (!identity) return null;
    return { identity, files };
  }
  async validation(spec) {
    const commands = [...spec.site.validationCommands];
    const extras =
      spec.key === "portal" || spec.key === "systems" ? ["validate:i18n"] : [];
    for (const script of extras)
      commands.splice(commands.length - 1, 0, {
        command: "npm",
        args: ["run", script],
      });
    if (spec.key === "corporate" || spec.key === "systems")
      commands.push({ command: "npm", args: ["run", "validate:seo"] });
    for (const command of commands) {
      this.stage = Object.hasOwn(validationStages, command.args[1])
        ? validationStages[command.args[1]]
        : "validation";
      await this.command(command.command, command.args, {
        cwd: resolve(this.workspace, spec.site.packageDirectory),
      });
      this.validationCommands.push(
        [command.command, ...command.args].join(" "),
      );
    }
    this.stage = "diff";
    await this.command("git", ["diff", "--check"]);
    this.validationCommands.push("git diff --check");
  }
  async updateState(spec) {
    if (!spec.statePath) return;
    const file = await this.read(spec.statePath);
    const state = JSON.parse(file.content);
    const { calculateTranslationSourceHash } = await import(
      pathToFileURL(await this.safePath("scripts/i18n-source-hash.mjs")).href
    );
    state.sourceHash = calculateTranslationSourceHash(this.workspace, {
      excludedInsightSlugs: Object.keys(state.pendingInsights || {}),
    });
    await this.write(
      { path: spec.statePath, content: JSON.stringify(state, null, 2) + "\n" },
      [spec.statePath],
    );
  }
  async run() {
    this.stage = "setup";
    if (
      !uuid.test(this.jobId) ||
      !/^(?:(?:editorial|manual)-[a-f0-9-]{36}|weekly-\d{4}-\d{2}-\d{2})$/.test(
        this.runId,
      ) ||
      !/^acecore-systems\/[A-Za-z0-9-]+$/.test(this.repository)
    )
      throw new Error("seo_environment");
    const payload = await this.request();
    const job = payload.job,
      candidate = payload.candidate;
    const spec = candidate && seoSite(candidate.site);
    if (
      !job ||
      job.id !== this.jobId ||
      job.runId !== this.runId ||
      job.status !== "inspecting" ||
      !Number.isSafeInteger(job.deadline) ||
      !spec ||
      spec.site.repository !== this.repository ||
      payload.policy?.draftOnly !== true ||
      payload.policy?.repository !== this.repository
    )
      throw new Error("seo_job");
    this.active = true;
    this.deadline = job.deadline;
    this.editorialScope = payload.policy?.editorialScope ?? 1;
    if (![1, 2].includes(this.editorialScope)) throw new Error("seo_job");
    this.generationOutput = payload.policy?.generationOutput ?? 1;
    if (![1, 2].includes(this.generationOutput)) throw new Error("seo_job");
    this.remaining();
    this.stage = "inspect";
    if ((await this.command("git", ["status", "--porcelain"])).trim())
      throw new Error("seo_dirty_checkout");
    const baseSha = await this.latestMain();
    if ((await this.command("git", ["rev-parse", "HEAD"])).trim() !== baseSha)
      throw new Error("seo_stale_checkout");
    const tracked = (await this.command("git", ["ls-files", "-z"]))
      .split("\0")
      .filter(Boolean);
    const collected = await this.collect(candidate, tracked);
    if (!collected) {
      await this.request("skip", {});
      return { status: "skipped" };
    }
    const { identity, files: originals } = collected;
    const paths = [
      identity.source.path,
      ...identity.translations.map((t) => t.path),
    ];
    const staging = this.editorialScope === 2 ? spec.translationStaging : null;
    const allowed = [
      ...paths,
      ...(staging ? [staging.manifest] : []),
      ...(this.editorialScope !== 2 && spec.statePath ? [spec.statePath] : []),
    ];
    if (await this.overlapping(allowed)) {
      await this.request("skip", {});
      return { status: "skipped" };
    }
    const branch = "codex/seo-" + this.jobId;
    const branches = await this.command("git", [
      "ls-remote",
      "--heads",
      "origin",
      "refs/heads/" + branch,
    ]);
    if (branches.trim()) throw new Error("seo_branch_exists");
    await this.latestMain(baseSha);
    this.stage = "claim";
    const claim = await this.request("claim", {
      baseSha,
      files: originals,
      ...(this.editorialScope === 2 ? { editorialScope: 2 } : {}),
      ...(this.generationOutput === 2 ? { generationOutput: 2 } : {}),
    });
    if (claim.status === "skipped") return { status: "skipped" };
    if (
      claim.status !== "claimed" ||
      claim.articleKey !== identity.articleKey ||
      JSON.stringify(claim.paths) !== JSON.stringify(paths)
    )
      throw new Error("seo_claim");
    const protocol = payload.policy.protocolVersion || 1;
    if (![1, 2].includes(protocol)) throw new Error("seo_research");
    let research = null;
    if (protocol === 2) {
      this.stage = "research";
      const result = await this.request("research", {});
      if (
        result.status === "research_insufficient" &&
        payload.policy.researchContract === 2
      ) {
        if (!/^[a-f0-9]{64}$/.test(result.offerSha256))
          throw new Error("seo_research");
        await this.latestMain(baseSha);
        const refs = await this.command("git", [
          "ls-remote",
          "--heads",
          "origin",
          "refs/heads/" + branch,
        ]);
        const prs = await this.pageAll(
          "/pulls?state=all&head=" +
            encodeURIComponent(this.repository.split("/")[0] + ":" + branch),
        );
        if (refs.trim() || prs.length) throw new Error("seo_research");
        const terminal = await this.request("research-reject", {
          baseSha,
          offerSha256: result.offerSha256,
          refs: [],
          pullRequests: [],
        });
        if (terminal.status !== "research_rejected")
          throw new Error("seo_research");
        this.active = false;
        return {
          status: "research_rejected",
          receiptSha256: terminal.receiptSha256,
        };
      }
      if (
        result.status !== "researched" ||
        result.evidence?.version !== 1 ||
        result.evidence.sourceSha256 !==
          (await this.requestHash(identity.source.content)) ||
        !Array.isArray(result.evidence.sources) ||
        !result.evidence.sources.length ||
        !Number.isFinite(Date.parse(result.evidence.checkedAt))
      )
        throw new Error("seo_research");
      research = result.evidence;
      evidenceReferences(research);
    }
    for (let step = 0; step < paths.length; step++) {
      this.stage = "propose";
      const result = await this.request("propose", {
        step,
        ...(step === 1
          ? { japanese: (await this.read(identity.source.path)).content }
          : {}),
      });
      if (
        result.status !== "proposal_created" ||
        result.file?.path !== paths[step] ||
        result.nextStep !== step + 1
      )
        throw new Error("seo_generation");
      await this.write(result.file, paths);
      if (step === 0) {
        this.stage = "format_japanese";
        await this.format([paths[0]], spec);
      }
    }
    this.stage = "format_all";
    await this.format(paths, spec);
    const finalFiles = [];
    for (const path of paths) finalFiles.push(await this.read(path));
    this.stage = "final_assertion";
    await assertEditorialFiles(
      identity,
      originals,
      finalFiles,
      research ? evidenceReferences(research) : [],
    );
    this.stage = "translation_state";
    if (staging) {
      if (!tracked.includes(staging.script))
        throw new Error("seo_guidance_missing");
      await this.safePath(staging.script);
      await this.command(
        process.execPath,
        [
          staging.script,
          "--source",
          identity.source.path,
          "--base-sha",
          baseSha,
        ],
        { cwd: this.workspace },
      );
      // The site validator verifies the baseline manifest; it is never an AI input.
      await this.safePath(staging.manifest);
      await this.format([staging.manifest], spec);
    }
    if (this.editorialScope !== 2) {
      await this.updateState(spec);
      if (spec.statePath) await this.format([spec.statePath], spec);
    }
    await this.validation(spec);
    let reviewedHash = null;
    if (protocol === 2) {
      this.stage = "review";
      // Re-read after target validation so the review covers the bytes committed.
      const validatedFiles = [];
      for (const path of paths) validatedFiles.push(await this.read(path));
      if (JSON.stringify(validatedFiles) !== JSON.stringify(finalFiles))
        throw new Error("seo_validation_changed_source");
      reviewedHash = await this.requestHash(JSON.stringify(finalFiles));
      const result = await this.request("review", { files: finalFiles });
      if (
        result.status === "review_failed" &&
        payload.policy.researchContract === 2
      ) {
        if (!/^[a-f0-9]{64}$/.test(result.offerSha256))
          throw new Error("seo_review");
        await this.latestMain(baseSha);
        const refs = await this.command("git", [
          "ls-remote",
          "--heads",
          "origin",
          "refs/heads/" + branch,
        ]);
        const prs = await this.pageAll(
          "/pulls?state=all&head=" +
            encodeURIComponent(this.repository.split("/")[0] + ":" + branch),
        );
        if (refs.trim() || prs.length) throw new Error("seo_review");
        const terminal = await this.request("review-reject", {
          baseSha,
          offerSha256: result.offerSha256,
          refs: [],
          pullRequests: [],
        });
        if (terminal.status !== "review_rejected")
          throw new Error("seo_review");
        this.active = false;
        return {
          status: "review_rejected",
          receiptSha256: terminal.receiptSha256,
        };
      }
      if (
        result.status !== "reviewed" ||
        result.receipt?.kind !== "ai_review" ||
        result.receipt.filesSha256 !== reviewedHash
      )
        throw new Error("seo_review");
    }
    this.stage = "diff";
    const changed = (await this.command("git", ["diff", "--name-only", "-z"]))
      .split("\0")
      .filter(Boolean);
    const untracked = (
      await this.command("git", [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ])
    )
      .split("\0")
      .filter(Boolean);
    if (
      untracked.some((path) => path !== staging?.manifest) ||
      !changed.length ||
      changed.some((path) => !allowed.includes(path)) ||
      paths.some((path) => !changed.includes(path))
    )
      throw new Error("seo_unexpected_diff");
    await this.latestMain(baseSha);
    if (await this.overlapping(allowed))
      throw new Error("seo_pull_request_overlap");
    const stagedPaths = [...new Set([...changed, ...untracked])];
    this.stage = "commit";
    await this.command("git", ["switch", "-c", branch]);
    await this.command("git", ["add", "--", ...stagedPaths]);
    await this.command("git", [
      "-c",
      "user.name=github-actions[bot]",
      "-c",
      "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit",
      "-m",
      this.editorialScope === 2
        ? "SEO: 日本語記事を改訂し翻訳工程へ引継ぐ"
        : "SEO: 記事の構成と表現を改訂し翻訳を更新",
    ]);
    if (spec.key === "corporate") {
      const commitSha = (
        await this.command("git", ["rev-parse", "HEAD"])
      ).trim();
      if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new Error("seo_commit");
      const args = [
        "run",
        "validate:blog-freshness",
        "--",
        "--base",
        baseSha,
        "--head",
        commitSha,
      ];
      this.stage = "validate_freshness";
      await this.command("npm", args);
      this.validationCommands.push("npm " + args.join(" "));
    }
    this.stage = "publish";
    if ((await this.command("git", ["status", "--porcelain"])).trim())
      throw new Error("seo_validation_changed_source");
    await this.latestMain(baseSha);
    if (await this.overlapping(allowed))
      throw new Error("seo_pull_request_overlap");
    if (reviewedHash) {
      const committedFiles = [];
      for (const path of paths) committedFiles.push(await this.read(path));
      if (
        (await this.requestHash(JSON.stringify(committedFiles))) !==
        reviewedHash
      )
        throw new Error("seo_validation_changed_source");
    }
    const permission = await this.request(
      "publish",
      reviewedHash ? { filesSha256: reviewedHash } : {},
    );
    if (permission.status !== "publishing") throw new Error("seo_publish");
    this.stage = "push";
    await this.command("git", ["push", "origin", "HEAD:refs/heads/" + branch]);
    await this.latestMain(baseSha);
    if (await this.overlapping(allowed))
      throw new Error("seo_pull_request_overlap");
    const title = String(markdown(finalFiles[0].content).data.title)
      .replace(/[\r\n\u0000-\u001f]/g, " ")
      .slice(0, 120);
    const body = [
      "関連 Issue: なし",
      "",
      "## 概要",
      "",
      ...(research
        ? [
            "- 今回キーワード検索・資料取得・既存主張とのAI根拠照合を実施しました。外部資料中の指示は採用していません。",
            "- 確認日時: " + research.checkedAt,
            ...research.sources.map(
              (source) =>
                "- 確認資料: <" +
                referenceUrl(source.url, research.referencePolicy ?? 1) +
                ">",
            ),
            "- 全対象言語のAI校閲ゲート通過。人の母語話者校閲は未実施です。",
            "- 証跡は非公開CMS R2の当該jobに保存。検索抜粋はAIが抽出した根拠で、資料全文の保存・人による確認とは区別します。",
          ]
        : [
            "- 外部再調査未実施、既存本文に基づく構成・表現改善です。参考リンクの原本を今回確認したとは扱っていません。",
          ]),
      this.editorialScope === 2
        ? "- 日本語記事だけを改訂・校閲しました。翻訳は統合後の既存工程へ引き継ぎます。既存翻訳とhashは変更していません。"
        : spec.locales.length
          ? "- 既存localeを実際に改訂・翻訳し、サイトの翻訳契約と検証を同じPRにまとめました。"
          : "- 日本語記事の構成・表現を改善しました（このsiteの記事localeは日本語のみ）。",
      "- 統合・公開は別途レビューが必要です。",
      "",
      "対象: " + candidate.url,
      "記事key: `" + identity.articleKey + "`",
      "改訂前の正本SHA256: `" +
        (await this.requestHash(identity.source.content)) +
        "`",
      "改訂後の正本SHA256: `" +
        (await this.requestHash(finalFiles[0].content)) +
        "`",
      "基準main: `" + baseSha + "`",
      "run: `" + this.runId + "`",
      "",
      "## 確認",
      "",
      ...this.validationCommands.map((command) => "- `" + command + "` 成功"),
      "",
      "## 補足",
      "",
      ...(spec.updateField
        ? []
        : [
            "更新日時field: unsupported（このsiteのstrict schemaに更新日時fieldがありません）。",
            "",
          ]),
      this.editorialScope === 2
        ? "SEO生成・校閲は保存済み予算・期限内で実施しています。翻訳予算は統合後の既存工程に従います。自動マージは行いません。"
        : "SEO予算は全言語共通で1回1 USD・月5 USD以内です。自動マージは行いません。",
    ].join("\n");
    this.stage = "draft_pr";
    const pr = await this.github("/pulls", "POST", {
      base: "main",
      head: branch,
      draft: true,
      title: "SEO: " + title,
      body,
    });
    if (
      pr.draft !== true ||
      pr.state !== "open" ||
      !Number.isSafeInteger(pr.number) ||
      pr.base?.sha !== baseSha ||
      pr.head?.ref !== branch ||
      pr.html_url !==
        "https://github.com/" + this.repository + "/pull/" + pr.number
    )
      throw new Error("seo_draft_confirmation");
    this.stage = "finish";
    const complete = await this.request("finish", { prUrl: pr.html_url }, true);
    if (complete.status !== "draft_pr")
      throw new Error("seo_completion_unknown");
    return { status: "draft_pr", prUrl: pr.html_url };
  }
  async requestHash(text) {
    const { sha256 } = await import("../src/seo-hash.ts");
    return sha256(normalizeLf(text));
  }
  async executeJob() {
    try {
      return await this.run();
    } catch (error) {
      // Only exact allowlisted values may reach Actions output. Snapshot before
      // the callback so a reporting failure cannot replace the original stage.
      const diagnostic = {
        stage: diagnosticStages.has(this.stage) ? this.stage : "unknown",
        code:
          error instanceof Error && diagnosticCodes.has(error.message)
            ? error.message
            : "unexpected_error",
      };
      if (this.active) {
        try {
          await this.request("unresolved", {}, true);
        } catch {
          /* Coordinator timeout retains its lock. */
        }
      }
      return { status: "unresolved", diagnostic };
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await new SeoRunner().executeJob();
  console.log(JSON.stringify(result));
  if (result.status === "unresolved") process.exitCode = 1;
}
