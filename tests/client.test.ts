import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

async function setup(fail = false) {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://site.test/admin/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const window = dom.window;
  const posted: FormData[] = [];
  window.URL.createObjectURL = vi.fn(() => "blob:https://site.test/test-image");
  window.URL.revokeObjectURL = vi.fn();
  window.fetch = vi.fn(async (url, options) => {
    if (options?.method === "POST") {
      posted.push(options.body as FormData);
      if (fail)
        return Response.json({ message: "テスト送信失敗" }, { status: 503 });
      return Response.json({
        conversation: {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          jobs: [],
          status: "responded",
        },
      });
    }
    if (String(url).endsWith("session"))
      return Response.json({ role: "editor", capabilities: { edit: true } });
    return Response.json({ conversations: [] });
  });
  window.eval(
    await readFile(
      new URL("../client/cms-ai-panel.js", import.meta.url),
      "utf8",
    ),
  );
  const document = window.document;
  (document.querySelector(".cms-ai-launcher") as HTMLButtonElement).click();
  await vi.waitFor(() =>
    expect(
      document.querySelector(".cms-ai-panel__body")?.hasAttribute("hidden"),
    ).toBe(false),
  );
  const input = document.querySelector(
    ".cms-ai-image-input",
  ) as HTMLInputElement;
  const form = document.querySelector("form")!;
  const attach = (count = 1) => {
    Object.defineProperty(input, "files", {
      configurable: true,
      value: Array.from(
        { length: count },
        () => new window.File(["fixture"], "参考.png", { type: "image/png" }),
      ),
    });
    input.dispatchEvent(new window.Event("change"));
  };
  return { dom, window, document, input, form, attach, posted };
}

describe("image composer", () => {
  it("添付のプレビュー・削除・新規会話でobject URLを解放する", async () => {
    const ui = await setup();
    try {
      ui.attach();
      expect(
        ui.document.querySelectorAll(".cms-ai-attachments img"),
      ).toHaveLength(1);
      (
        ui.document.querySelector(
          ".cms-ai-attachments button",
        ) as HTMLButtonElement
      ).click();
      expect(ui.window.URL.revokeObjectURL).toHaveBeenCalledTimes(1);
      ui.attach();
      (
        ui.document.querySelector(
          ".cms-ai-new-conversation",
        ) as HTMLButtonElement
      ).click();
      expect(
        ui.document.querySelectorAll(".cms-ai-attachments img"),
      ).toHaveLength(0);
      expect(ui.window.URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    } finally {
      ui.window.close();
    }
  });
  it("画像のみ送信でき、成功後に添付を消す", async () => {
    const ui = await setup();
    try {
      ui.attach();
      ui.form.dispatchEvent(
        new ui.window.Event("submit", { cancelable: true }),
      );
      await vi.waitFor(() => expect(ui.posted).toHaveLength(1));
      expect(ui.posted[0].getAll("images")).toHaveLength(1);
      expect(ui.posted[0].get("reasoningEffort")).toBe("medium");
      await vi.waitFor(() =>
        expect(
          ui.document.querySelectorAll(".cms-ai-attachments img"),
        ).toHaveLength(0),
      );
    } finally {
      ui.window.close();
    }
  });
  it("失敗時は添付を保持し、重複送信を防止する", async () => {
    const ui = await setup(true);
    try {
      ui.attach();
      ui.form.dispatchEvent(
        new ui.window.Event("submit", { cancelable: true }),
      );
      ui.form.dispatchEvent(
        new ui.window.Event("submit", { cancelable: true }),
      );
      await vi.waitFor(() =>
        expect(
          ui.document.querySelector(".cms-ai-form__status")?.textContent,
        ).toBe("テスト送信失敗"),
      );
      expect(ui.posted).toHaveLength(1);
      expect(
        ui.document.querySelectorAll(".cms-ai-attachments img"),
      ).toHaveLength(1);
      expect(ui.input.disabled).toBe(false);
    } finally {
      ui.window.close();
    }
  });
  it("枚数超過を拒否し、画像貼り付けを受け付ける", async () => {
    const ui = await setup();
    try {
      ui.attach(5);
      expect(
        ui.document.querySelectorAll(".cms-ai-attachments img"),
      ).toHaveLength(0);
      const event = new ui.window.Event("paste", { cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          files: [
            new ui.window.File(["fixture"], "clip.png", { type: "image/png" }),
          ],
          getData: () => "",
        },
      });
      ui.document.querySelector("textarea")!.dispatchEvent(event);
      expect(
        ui.document.querySelectorAll(".cms-ai-attachments img"),
      ).toHaveLength(1);
    } finally {
      ui.window.close();
    }
  });
});
