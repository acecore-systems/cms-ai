export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

export function methodNotAllowed(methods: string[]) {
  return json({ message: "Method not allowed" }, 405, {
    Allow: methods.join(", "),
  });
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("Origin");

  if (!origin) {
    throw new HttpError(403, "許可されていないリクエストです。");
  }

  let originUrl: URL;

  try {
    originUrl = new URL(origin);
  } catch {
    throw new HttpError(403, "許可されていないリクエストです。");
  }

  if (originUrl.origin !== new URL(request.url).origin) {
    throw new HttpError(403, "許可されていないリクエストです。");
  }
}

export function toErrorResponse(error: unknown, event: string) {
  if (error instanceof HttpError) {
    return json({ message: error.message }, error.status);
  }

  console.error(
    JSON.stringify({
      event,
      error: error instanceof Error ? error.message : String(error),
    }),
  );

  return json(
    {
      message: "CMS AIを処理できませんでした。時間をおいて再試行してください。",
    },
    500,
  );
}

export async function readJsonObject(request: Request, maxBytes = 64 * 1024) {
  const contentLength = Number(request.headers.get("Content-Length") || "0");

  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpError(413, "リクエストが大きすぎます。");
  }

  const raw = await request.text();

  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new HttpError(413, "リクエストが大きすぎます。");
  }

  let body: unknown = null;

  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "入力形式を確認してください。");
  }

  return body as Record<string, unknown>;
}

export function optionalText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

export function requiredText(value: unknown, maxLength: number) {
  const normalized = optionalText(value, maxLength);

  if (!normalized) throw new HttpError(400, "入力内容を確認してください。");
  return normalized;
}

export function normalizeEmail(value: unknown) {
  const email = optionalText(value, 320)?.toLowerCase() || "";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "メールアドレスを確認してください。");
  }

  return email;
}
