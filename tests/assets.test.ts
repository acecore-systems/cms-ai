import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("shared client and runner assets", () => {
  it("会話UIはURL・画像入力なしでroleとeffortを扱う", async () => {
    const source = await readFile(
      new URL("../client/cms-ai-panel.js", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/AIと相談/);
    expect(source).toMatch(/session\?\.role/);
    expect(source).toMatch(/reasoningEffort/);
    expect(source).toMatch(/\/messages/);
    expect(source).not.toMatch(/targetUrl|referenceImage|画像入力|対象URL/);
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
    expect(runner).not.toMatch(/'pr',\s*'merge'|auto.?merge\s*=\s*true/i);
    expect(workflow).toMatch(/id-token: write/);
    expect(workflow).toMatch(/acecore-systems\/cms-ai\/runner@v1/);
  });

  it("Worker設定はGLM-5.3を使いautomergeをfalseに固定する", async () => {
    const config = await readFile(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    );
    expect(config).toMatch(/@cf\/zai-org\/glm-5\.3/);
    expect(config).toMatch(/CMS_AI_AUTOMERGE_ENABLED.*false/);
  });
});
