import { HttpError } from "./http.ts";
const codes = [
  "insufficient_quota",
  "model_not_found",
  "invalid_api_key",
  "unsupported_value",
  "invalid_value",
  "invalid_request_error",
  "rate_limit_exceeded",
  "server_error",
];
const params = [
  "model",
  "reasoning_effort",
  "max_completion_tokens",
  "response_format",
  "service_tier",
];
export class ProviderFailure extends HttpError {
  constructor(
    readonly providerStatus: number,
    readonly providerCode: string,
    readonly providerParam: string | null,
  ) {
    super(502, "AI APIがリクエストを受け付けませんでした。");
  }
}
export async function providerFailure(response: Response) {
  let code = "unclassified",
    param: string | null = null;
  const reader = response.body?.getReader();
  try {
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader)
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16384) throw new Error("limit");
        chunks.push(value);
      }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (codes.includes(parsed?.error?.code)) code = parsed.error.code;
    if (params.includes(parsed?.error?.param)) param = parsed.error.param;
  } catch {
    /* Never forward provider messages or values. */
  } finally {
    try {
      await reader?.cancel();
    } catch {
      /* Ignore stream teardown. */
    }
  }
  return new ProviderFailure(response.status, code, param);
}
