import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const jobId = process.argv[2] || process.env.CMS_AI_JOB_ID || "";
const repository = process.env.GITHUB_REPOSITORY || "";
const runnerUrl = String(process.env.CMS_AI_RUNNER_URL || "").replace(
  /\/$/,
  "",
);
const runnerAudience = process.env.CMS_AI_RUNNER_AUDIENCE || runnerUrl;
const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
const maxContextBytes = 768 * 1024;
const maxConversationChangedPaths = 100;
const validationExcludedDirectories = new Set([
  ".astro",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
]);
const allowedExtensions = new Set([
  ".astro",
  ".css",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
]);
let activeJob = null;

if (!isUuid(jobId) || !runnerUrl || !runnerAudience || !repository) {
  throw new Error("CMS AI runnerの実行環境またはジョブIDが不正です。");
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof Error ? error.message : "CMS AI automation failed";
  await reportFailure(message);
  console.error(message);
  process.exitCode = 1;
}

async function main() {
  const payload = await runnerRequest("/jobs/" + encodeURIComponent(jobId));
  const job = payload?.job;
  const policy = validatePolicy(payload?.policy);

  validateJob(job, policy);
  activeJob = job;

  if (!["queued", "running", "validating"].includes(job.status)) {
    console.log("CMS AI job is already terminal:", job.status);
    return;
  }

  await updateStatus({
    status: "running",
    summary: "AIが会話と関連ソースを確認しています。",
  });
  const existingBranch = await prepareConversationBranch(job, policy);
  let validationFeedback = "";

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const sourceFiles = await collectSourceFiles(job, policy);
    const inference = await runnerRequest("/inference", {
      body: {
        files: sourceFiles,
        jobId,
        ...(validationFeedback
          ? { validationFeedback: trimOutput(validationFeedback, 12_000) }
          : {}),
      },
      method: "POST",
    });

    if (inference.status === "responded") {
      console.log(
        "CMS AI returned a conversation response without file changes.",
      );
      return;
    }

    const result = inference.result;

    if (!result || !Array.isArray(result.changes) || !result.changes.length) {
      throw new Error("CMS AIから回答または変更案を受け取れませんでした。");
    }

    const originals = await applyChanges(result.changes, policy);
    const changedPaths = await getWorkingTreeChangedPaths();

    if (!changedPaths.length) {
      await updateStatus({
        assistantMessage:
          result.summary || "現在の内容に追加のファイル変更はありません。",
        status: "responded",
        summary: result.summary || "追加のファイル変更はありません。",
      });
      return;
    }

    assertWritablePaths(changedPaths, policy);
    await updateStatus({
      changedPaths,
      status: "validating",
      summary: result.summary || "変更を検証しています。",
    });
    const validation = await runValidation(policy);

    if (validation.ok) {
      await createPullRequest(
        job,
        policy,
        result,
        existingBranch,
        changedPaths,
      );
      return;
    }

    await restoreChanges(originals);
    validationFeedback = validation.output;

    if (attempt < 3) {
      await updateStatus({
        status: "running",
        summary: "検証結果をもとに、AIが変更案を再確認しています。",
      });
      continue;
    }

    throw new Error(
      "AIの変更は3回の検証で通りませんでした。\n" +
        trimOutput(validation.output, 2_000),
    );
  }
}

function validateJob(job, policy) {
  if (
    !job ||
    job.id !== jobId ||
    !isUuid(job.conversationId) ||
    job.branchName !== "ai/cms-" + job.conversationId ||
    !Number.isInteger(job.turnNumber) ||
    job.turnNumber < 1 ||
    job.turnNumber > 30 ||
    policy.repository !== repository
  ) {
    throw new Error("CMS AIジョブを安全に確認できません。");
  }
}

function validatePolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CMS AIのサイトポリシーを確認できません。");
  }

  const policy = {
    autoMergeEnabled: value.autoMergeEnabled,
    baseBranch: requiredPolicyText(value.baseBranch),
    canonicalUrl: requiredPolicyText(value.canonicalUrl),
    packageDirectory: String(value.packageDirectory || "."),
    projectRoot: String(value.projectRoot || ""),
    repository: requiredPolicyText(value.repository),
    sourcePrefixes: validatePrefixes(value.sourcePrefixes),
    validationCommands: validateCommands(value.validationCommands),
    writablePrefixes: validatePrefixes(value.writablePrefixes),
  };

  if (
    policy.autoMergeEnabled !== false ||
    !/^[A-Za-z0-9._/-]+$/.test(policy.baseBranch) ||
    !/^https:\/\//.test(policy.canonicalUrl) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy.repository) ||
    !isSafeDirectory(policy.packageDirectory) ||
    !isSafeProjectRoot(policy.projectRoot)
  ) {
    throw new Error("CMS AIのサイトポリシーが許可範囲外です。");
  }

  return policy;
}

function validatePrefixes(value) {
  if (!Array.isArray(value) || !value.length || value.length > 20) {
    throw new Error("CMS AIのpathポリシーを確認できません。");
  }

  return value.map((prefix) => {
    if (
      typeof prefix !== "string" ||
      !prefix.endsWith("/") ||
      !normalizePath(prefix.slice(0, -1))
    ) {
      throw new Error("CMS AIのpathポリシーを確認できません。");
    }
    return prefix;
  });
}

function validateCommands(value) {
  if (!Array.isArray(value) || !value.length || value.length > 10) {
    throw new Error("CMS AIの検証コマンドを確認できません。");
  }

  const allowedScripts = new Set([
    "build",
    "check",
    "format:check",
    "test:cms",
    "typecheck:functions",
    "validate:content",
  ]);

  return value.map((entry) => {
    if (
      !entry ||
      entry.command !== "npm" ||
      !Array.isArray(entry.args) ||
      !entry.args.every((arg) => typeof arg === "string")
    ) {
      throw new Error("CMS AIの検証コマンドを確認できません。");
    }

    const valid =
      (entry.args.length === 1 && entry.args[0] === "test") ||
      (entry.args.length === 2 &&
        entry.args[0] === "run" &&
        allowedScripts.has(entry.args[1]));

    if (!valid) throw new Error("CMS AIの検証コマンドが許可範囲外です。");
    return { args: [...entry.args], command: "npm" };
  });
}

async function prepareConversationBranch(job, policy) {
  if (job.prUrl) {
    const details = await readPullRequest(job.prUrl);
    if (details.state !== "OPEN") {
      throw new Error(
        "この会話のPull Requestは終了済みです。新しい会話を開始してください。",
      );
    }
  }

  await runRequired("git", ["fetch", "origin", policy.baseBranch]);
  const lookup = await runCommand("git", [
    "ls-remote",
    "--heads",
    "origin",
    "refs/heads/" + job.branchName,
  ]);

  if (!lookup.ok) {
    throw new Error("CMS AIの会話branchを確認できません。\n" + lookup.output);
  }

  if (!lookup.output.trim()) {
    await runRequired("git", [
      "switch",
      "--force-create",
      policy.baseBranch,
      "origin/" + policy.baseBranch,
    ]);
    await assertCleanWorkingTree();
    return false;
  }

  await runRequired("git", [
    "fetch",
    "origin",
    "refs/heads/" + job.branchName + ":refs/remotes/origin/" + job.branchName,
  ]);
  await runRequired("git", [
    "switch",
    "--force-create",
    job.branchName,
    "origin/" + job.branchName,
  ]);
  await assertCleanWorkingTree();
  const existingPaths = await getBranchChangedPaths(policy);

  if (
    existingPaths.length > maxConversationChangedPaths ||
    existingPaths.some((path) => !isWritablePath(path, policy))
  ) {
    throw new Error(
      "会話branchに許可範囲外の変更があるため、自動処理を停止しました。",
    );
  }

  return true;
}

async function collectSourceFiles(job, policy) {
  const allPaths = await walkDirectory(workspace);
  const words = String(job.instruction || "")
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((word) => word.length >= 3);
  const candidates = allPaths
    .filter((path) => isSourcePath(path, policy))
    .sort(
      (left, right) =>
        scorePath(right, words) - scorePath(left, words) ||
        left.localeCompare(right),
    );
  const files = [];
  let totalBytes = 0;

  for (const path of candidates) {
    const content = await readFile(resolveWorkspacePath(path), "utf8").catch(
      () => null,
    );
    if (content === null || content.includes("\u0000")) continue;
    const bytes = Buffer.byteLength(content);
    if (bytes > 128 * 1024 || totalBytes + bytes > maxContextBytes) continue;
    files.push({ content, path });
    totalBytes += bytes;
    if (files.length >= 80) break;
  }

  if (!files.length) {
    throw new Error("AIへ渡すサイトソースを見つけられませんでした。");
  }

  return files;
}

async function walkDirectory(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];

  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    const path = relative(workspace, absolute).replaceAll("\\", "/");

    if (entry.isDirectory()) {
      if (
        path === ".git" ||
        path === "dist" ||
        path === "node_modules" ||
        path === ".astro" ||
        path === "coverage" ||
        path.startsWith(".git/") ||
        path.startsWith("node_modules/")
      ) {
        continue;
      }
      paths.push(...(await walkDirectory(root, absolute)));
    } else if (entry.isFile()) {
      paths.push(path);
    }
  }

  return paths;
}

function scorePath(path, words) {
  const lower = path.toLowerCase();
  let score = 0;
  if (lower.includes("/pages/")) score += 20;
  if (lower.includes("/content/")) score += 15;
  if (lower.includes("/components/")) score += 8;
  if (lower.includes("/layouts/")) score += 8;
  if (lower.includes("/styles/")) score += 6;
  for (const word of words) if (lower.includes(word)) score += 10;
  return score;
}

async function applyChanges(changes, policy) {
  if (changes.length > 20) throw new Error("CMS AIの変更件数が多すぎます。");
  const originals = new Map();

  for (const change of changes) {
    if (
      !change ||
      typeof change.path !== "string" ||
      typeof change.content !== "string" ||
      !isWritablePath(change.path, policy)
    ) {
      throw new Error("CMS AIの変更先が許可範囲外です。");
    }

    const path = normalizePath(change.path);
    const absolute = resolveWorkspacePath(path);
    await assertNoSymlinkPath(path);
    const original = await readFile(absolute, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    originals.set(path, original);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, change.content, "utf8");
  }

  return originals;
}

async function assertNoSymlinkPath(path) {
  let current = workspace;

  for (const part of path.split("/")) {
    current = resolve(current, part);
    const stats = await lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });

    if (!stats) return;
    if (stats.isSymbolicLink()) {
      throw new Error("symbolic link経由のファイル変更は許可されていません。");
    }
  }
}

async function restoreChanges(originals) {
  for (const [path, original] of originals) {
    const absolute = resolveWorkspacePath(path);
    if (original === null) await rm(absolute, { force: true });
    else await writeFile(absolute, original, "utf8");
  }
}

async function runValidation(policy) {
  await assertNoPersistedGitHubCredential();
  const nodeVersion = await readNodeVersion();
  const sandbox = await createValidationSandbox();
  const output = [];

  try {
    const install = await runSandboxCommand(
      sandbox.workspace,
      policy.packageDirectory,
      nodeVersion,
      "npm",
      ["ci", "--no-audit", "--no-fund"],
      true,
    );
    output.push("$ npm ci --no-audit --no-fund\n" + install.output);

    if (!install.ok) {
      return {
        ok: false,
        output: trimOutput(output.join("\n\n"), 16_000),
      };
    }

    for (const entry of policy.validationCommands) {
      const result = await runSandboxCommand(
        sandbox.workspace,
        policy.packageDirectory,
        nodeVersion,
        entry.command,
        entry.args,
        false,
      );
      output.push(
        "$ " +
          entry.command +
          " " +
          entry.args.join(" ") +
          "\n" +
          result.output,
      );
      if (!result.ok) {
        return {
          ok: false,
          output: trimOutput(output.join("\n\n"), 16_000),
        };
      }
    }
  } finally {
    await removeValidationSandbox(sandbox.root);
  }

  return { ok: true, output: trimOutput(output.join("\n\n"), 4_000) };
}

async function assertNoPersistedGitHubCredential() {
  const result = await runCommand("git", [
    "config",
    "--local",
    "--get-regexp",
    "^http\\..*\\.extraheader$",
  ]);

  if (result.ok && result.output.trim()) {
    throw new Error("checkout資格情報がworktreeへ残っているため停止しました。");
  }
}

async function readNodeVersion() {
  const value = (
    await readFile(resolveWorkspacePath(".node-version"), "utf8")
  ).trim();

  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error("検証用Node.jsのversionを確認できません。");
  }

  return value;
}

async function createValidationSandbox() {
  const root = await mkdtemp(join(resolve(tmpdir()), "cms-ai-validation-"));
  const sandboxWorkspace = join(root, "workspace");

  try {
    await cp(workspace, sandboxWorkspace, {
      filter(source) {
        const path = relative(workspace, source).replaceAll("\\", "/");

        return (
          !path ||
          !path
            .split("/")
            .some((part) => validationExcludedDirectories.has(part))
        );
      },
      recursive: true,
      verbatimSymlinks: true,
    });
  } catch (error) {
    await removeValidationSandbox(root);
    throw error;
  }

  return { root, workspace: sandboxWorkspace };
}

async function removeValidationSandbox(root) {
  const resolvedRoot = resolve(root);

  if (
    dirname(resolvedRoot) !== resolve(tmpdir()) ||
    !basename(resolvedRoot).startsWith("cms-ai-validation-")
  ) {
    throw new Error("検証用一時directoryの削除範囲を確認できません。");
  }

  await rm(resolvedRoot, { force: true, recursive: true });
}

function runSandboxCommand(
  sandboxWorkspace,
  packageDirectory,
  nodeVersion,
  command,
  args,
  allowNetwork,
) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;

  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error("検証sandboxはLinux runnerで実行してください。");
  }

  const normalizedPackageDirectory =
    packageDirectory === "." ? "" : normalizePath(packageDirectory);

  if (normalizedPackageDirectory === null) {
    throw new Error("検証対象directoryを確認できません。");
  }

  const packagePath = normalizedPackageDirectory
    ? "/workspace/" + normalizedPackageDirectory
    : "/workspace";
  const dockerArgs = [
    "run",
    "--rm",
    "--init",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "512",
    "--memory",
    "4g",
    "--cpus",
    "2",
    "--user",
    `${uid}:${gid}`,
    "--network",
    allowNetwork ? "bridge" : "none",
    "--env",
    "CI=true",
    "--env",
    "HOME=/tmp",
    "--mount",
    `type=bind,src=${sandboxWorkspace},dst=/workspace`,
    "--workdir",
    packagePath,
  ];

  for (const name of [
    "GITHUB_ACTIONS",
    "GITHUB_REF",
    "GITHUB_REF_NAME",
    "GITHUB_REPOSITORY",
    "GITHUB_SHA",
  ]) {
    const value = process.env[name];
    if (value) dockerArgs.push("--env", `${name}=${value}`);
  }

  dockerArgs.push(`node:${nodeVersion}-bookworm`, command, ...args);
  return runCommand("docker", dockerArgs);
}

async function createPullRequest(
  job,
  policy,
  result,
  existingBranch,
  latestChangedPaths,
) {
  if (!existingBranch)
    await runRequired("git", ["switch", "-c", job.branchName]);
  await runRequired("git", ["config", "user.name", "github-actions[bot]"]);
  await runRequired("git", [
    "config",
    "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ]);
  await runRequired("git", ["add", "--", ...latestChangedPaths]);
  await runRequired("git", [
    "commit",
    "-m",
    `cms: AI conversation ${job.conversationId} turn ${job.turnNumber}`,
  ]);
  const conversationPaths = await getBranchChangedPaths(policy);

  if (
    !conversationPaths.length ||
    conversationPaths.length > maxConversationChangedPaths
  ) {
    throw new Error("会話branchの変更範囲を安全に確認できません。");
  }
  assertWritablePaths(conversationPaths, policy);
  await runRequired("git", [
    "push",
    "origin",
    "HEAD:refs/heads/" + job.branchName,
  ]);

  const body = [
    "## 概要",
    "",
    result.summary || "CMS AIによるサイト修正です。",
    "",
    "## 会話",
    "",
    `- Conversation: \`${job.conversationId}\``,
    `- Turn: ${job.turnNumber}`,
    "",
    "## 最新のメッセージ",
    "",
    ...quoteMarkdown(job.instruction),
    "",
    "## 変更ファイル",
    "",
    ...conversationPaths.map((path) => "- " + path),
    "",
    "## 自動確認",
    "",
    ...policy.validationCommands.map(
      (entry) => "- `" + entry.command + " " + entry.args.join(" ") + "`",
    ),
    "",
    "自動マージは行いません。内容とCIを確認してからマージしてください。",
  ].join("\n");
  const title = "CMS AI: " + trimOneLine(result.summary || "サイト修正", 80);
  const pulls = await listPullRequests(job.branchName);
  const open = pulls.find((pull) => pull.state === "OPEN");
  const closed = pulls.find((pull) => pull.state !== "OPEN");
  let prUrl = open?.url || "";

  if (prUrl) {
    await runRequired("gh", [
      "pr",
      "edit",
      prUrl,
      "--repo",
      repository,
      "--title",
      title,
      "--body",
      body,
    ]);
  } else {
    if (closed) {
      throw new Error(
        "この会話のPull Requestは終了済みです。新しい会話を開始してください。",
      );
    }
    const output = await runRequired("gh", [
      "pr",
      "create",
      "--repo",
      repository,
      "--base",
      policy.baseBranch,
      "--head",
      job.branchName,
      "--title",
      title,
      "--body",
      body,
    ]);
    prUrl = findPullRequestUrl(output);
  }

  await updateStatus({
    assistantMessage:
      result.summary || "Pull Requestを作成し、確認できる状態にしました。",
    changedPaths: latestChangedPaths,
    prUrl,
    status: "pr_created",
    summary: "Pull Requestを作成しました。内容とCIを確認してください。",
  });
  console.log("CMS AI left Pull Request open for review:", prUrl);
}

async function getWorkingTreeChangedPaths() {
  const tracked = await runRequired("git", ["diff", "--name-only"]);
  const untracked = await runRequired("git", [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  return uniquePaths(tracked + "\n" + untracked);
}

async function getBranchChangedPaths(policy) {
  const output = await runRequired("git", [
    "diff",
    "--name-only",
    `origin/${policy.baseBranch}...HEAD`,
  ]);
  return uniquePaths(output);
}

function uniquePaths(output) {
  return Array.from(
    new Set(
      output
        .split(/\r?\n/)
        .map((path) => path.trim().replaceAll("\\", "/"))
        .filter(Boolean),
    ),
  ).sort();
}

function assertWritablePaths(paths, policy) {
  if (paths.some((path) => !isWritablePath(path, policy))) {
    throw new Error("許可範囲外の変更が検出されたため停止しました。");
  }
}

function isSourcePath(value, policy) {
  const path = normalizePath(value);
  if (!path || !policy.sourcePrefixes.some((prefix) => path.startsWith(prefix)))
    return false;
  return isAllowedTextPath(path, policy);
}

function isWritablePath(value, policy) {
  const path = normalizePath(value);
  if (
    !path ||
    !policy.writablePrefixes.some((prefix) => path.startsWith(prefix))
  )
    return false;
  return isAllowedTextPath(path, policy);
}

function isAllowedTextPath(path, policy) {
  if (!allowedExtensions.has(extname(path).toLowerCase())) return false;
  const relativePath = policy.projectRoot
    ? path.slice(policy.projectRoot.length)
    : path;
  if (
    /^src\/middleware(?:\.|\/)/i.test(relativePath) ||
    /^src\/env\.d\.ts$/i.test(relativePath) ||
    /(^|\/)(auth|checkout|oauth|payments?|secrets?|stripe|webhook)([._/-]|$)/i.test(
      relativePath,
    )
  )
    return false;
  return ![
    ".github/",
    "functions/",
    "migrations/",
    "scripts/",
    "tests/",
    "public/admin/",
    "public/uploads/",
    "src/pages/api/",
  ].some((prefix) => relativePath.startsWith(prefix));
}

function normalizePath(value) {
  if (typeof value !== "string") return null;
  const path = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    !path ||
    path.length > 240 ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    return null;
  return path;
}

function resolveWorkspacePath(value, allowDirectory = false) {
  const normalized =
    allowDirectory && value === "." ? "" : normalizePath(value);
  if (normalized === null)
    throw new Error("workspace内のpathを確認できません。");
  const absolute = resolve(workspace, normalized);
  if (absolute !== workspace && !absolute.startsWith(workspace + sep)) {
    throw new Error("workspace外のpathは利用できません。");
  }
  return absolute;
}

function isSafeDirectory(value) {
  return value === "." || Boolean(normalizePath(value));
}

function isSafeProjectRoot(value) {
  return (
    value === "" ||
    (value.endsWith("/") && Boolean(normalizePath(value.slice(0, -1))))
  );
}

function requiredPolicyText(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 300) {
    throw new Error("CMS AIのサイトポリシーを確認できません。");
  }
  return value.trim();
}

function assertCleanWorkingTree() {
  return runRequired("git", ["status", "--porcelain"]).then((output) => {
    if (output.trim())
      throw new Error("checkout後のworktreeがcleanではありません。");
  });
}

async function listPullRequests(branchName) {
  const output = await runRequired("gh", [
    "pr",
    "list",
    "--repo",
    repository,
    "--head",
    branchName,
    "--state",
    "all",
    "--limit",
    "20",
    "--json",
    "state,url",
  ]);
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new Error("既存Pull Requestを確認できません。");
  }
}

async function readPullRequest(url) {
  const output = await runRequired("gh", [
    "pr",
    "view",
    url,
    "--repo",
    repository,
    "--json",
    "state,url",
  ]);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("既存Pull Requestを確認できません。");
  }
}

function findPullRequestUrl(output) {
  const match = output.match(
    /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/,
  );
  if (!match) throw new Error("作成したPull RequestのURLを確認できません。");
  return match[0];
}

async function updateStatus(body) {
  const result = await runnerRequest(
    "/jobs/" + encodeURIComponent(jobId) + "/status",
    {
      body,
      method: "POST",
    },
  );

  if (activeJob && typeof body.status === "string") {
    activeJob = { ...activeJob, status: body.status };
  }

  return result;
}

async function reportFailure(message) {
  if (
    !activeJob ||
    !["queued", "running", "validating"].includes(activeJob.status)
  )
    return;
  try {
    await updateStatus({
      changedPaths: [],
      errorMessage: trimOutput(message, 2_000),
      status: "failed",
      summary: "CMS AIの自動処理を停止しました。",
    });
  } catch (error) {
    console.error("CMS AI failure status could not be reported:", error);
  }
}

async function runnerRequest(path, options = {}) {
  const token = await getOidcToken();
  const response = await fetch(runnerUrl + path, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: {
      Authorization: "Bearer " + token,
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    method: options.method || "GET",
    signal: AbortSignal.timeout(180_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof payload.message === "string"
        ? payload.message
        : `CMS AI runner request failed (${response.status})`,
    );
  }
  return payload;
}

async function getOidcToken() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL || "";
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || "";
  if (!requestUrl || !requestToken) {
    throw new Error("GitHub Actions OIDCを利用できません。");
  }
  const separator = requestUrl.includes("?") ? "&" : "?";
  const response = await fetch(
    requestUrl + separator + "audience=" + encodeURIComponent(runnerAudience),
    {
      headers: { Authorization: "Bearer " + requestToken },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.value !== "string") {
    throw new Error("GitHub Actions OIDC tokenを取得できません。");
  }
  return payload.value;
}

async function runRequired(command, args, options = {}) {
  const result = await runCommand(command, args, options);
  if (!result.ok) {
    throw new Error(
      `${command} ${args.join(" ")} failed.\n${trimOutput(result.output, 4_000)}`,
    );
  }
  return result.output;
}

async function runCommand(command, args, options = {}) {
  try {
    const environment = { ...process.env, CI: "true" };

    if (command === "git") {
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

      if (token) {
        environment.GIT_CONFIG_COUNT = "1";
        environment.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
        environment.GIT_CONFIG_VALUE_0 =
          "AUTHORIZATION: basic " +
          Buffer.from("x-access-token:" + token).toString("base64");
      }
    }

    const result = await execFileAsync(command, args, {
      cwd: options.cwd || workspace,
      env: environment,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      ok: true,
      output: String(result.stdout || "") + String(result.stderr || ""),
    };
  } catch (error) {
    return {
      ok: false,
      output:
        String(error?.stdout || "") +
        String(error?.stderr || "") +
        (error instanceof Error ? "\n" + error.message : ""),
    };
  }
}

function quoteMarkdown(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => "> " + line);
}

function trimOneLine(value, maxLength) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? text.slice(0, maxLength - 1) + "…" : text;
}

function trimOutput(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
