import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("shared client and runner assets", () => {
  it("会話UIはURL入力なしでrole・effort・画像添付を扱う", async () => {
    const source = await readFile(
      new URL("../client/cms-ai-panel.js", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/AIと相談/);
    expect(source).toMatch(/session\?\.role/);
    expect(source).toMatch(/reasoningEffort/);
    expect(source).toMatch(/\/messages/);
    expect(source).not.toMatch(/targetUrl|referenceImage|対象URL/);
    expect(source).toMatch(/type="file"/);
    expect(source).toMatch(/createObjectURL/);
    expect(source).toMatch(/revokeObjectURL/);
    expect(source).toMatch(/clipboardData/);
  });

  it("共有runnerはOIDC・path制限・固定検証を使い自動マージしない", async () => {
    const [action, runner, workflow] = await Promise.all([
      readFile(new URL("../runner/action.yml", import.meta.url), "utf8"),
      readFile(new URL("../runner/index.mjs", import.meta.url), "utf8"),
      readFile(new URL("../integration/cms-ai.yml", import.meta.url), "utf8"),
    ]);
    expect(action).toMatch(/runner-audience/);
    expect(runner).toMatch(/ACTIONS_ID_TOKEN_REQUEST_URL/);
    expect(runner).toMatch(/isWritablePath/);
    expect(runner).toMatch(/allowedScripts/);
    expect(runner).toMatch(/assertNoPersistedGitHubCredential/);
    expect(runner).toMatch(/assertNoSymlinkPath/);
    expect(runner).toMatch(/cms-ai-validation-/);
    expect(runner).toMatch(/runSandboxCommand/);
    expect(runner).toMatch(/allowNetwork \? "bridge" : "none"/);
    expect(runner).not.toMatch(/runCommand\("npm"/);
    expect(runner).not.toMatch(/'pr',\s*'merge'|auto.?merge\s*=\s*true/i);
    expect(workflow).toMatch(/workflow_dispatch:/);
    expect(workflow).not.toMatch(/repository_dispatch:/);
    expect(workflow).toMatch(/contents: write/);
    expect(workflow).toMatch(/id-token: write/);
    expect(workflow).toMatch(/pull-requests: write/);
    expect(workflow).toMatch(/actions\/checkout@v7/);
    expect(workflow).toMatch(/persist-credentials: false/);
    expect(workflow).toMatch(/actions\/setup-node@v7/);
    expect(workflow).toMatch(/acecore-systems\/cms-ai\/runner@v1/);
    expect(workflow).toMatch(/timeout-minutes: 45/);
  });

  it("Worker設定はGLM-5.3-Flashと非公開R2を使いautomergeをfalseに固定する", async () => {
    const config = await readFile(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    );
    expect(config).toMatch(/@cf\/zai-org\/glm-5\.3-flash/);
    expect(config).toMatch(/CMS_AI_IMAGES/);
    expect(config).toMatch(/CMS_AI_AUTOMERGE_ENABLED.*false/);
  });
});
