import type { AppEnv } from "./env.ts";
import { HttpError } from "./http.ts";

export async function getOpenAiApiKey(env: AppEnv): Promise<string> {
  try {
    const key = (await env.OPENAI_API_KEY_STORE?.get())?.trim();
    if (key) return key;
  } catch {
    // Secret-store errors may contain sensitive details; never surface them.
  }
  throw new HttpError(503, "OpenAI APIの設定がありません。");
}
