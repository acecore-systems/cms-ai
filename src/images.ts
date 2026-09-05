import type { AppEnv } from "./env.ts";
import { HttpError } from "./http.ts";
import type { ImageAttachment, Job } from "./models.ts";

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = MAX_IMAGES * MAX_IMAGE_BYTES + 64 * 1024;

export type UploadedImage = { attachment: ImageAttachment; bytes: ArrayBuffer };
export type MessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

// Count actual streamed bytes, not just the untrusted Content-Length header.
export async function boundedRequest(request: Request) {
  if (Number(request.headers.get("Content-Length")) > MAX_MESSAGE_BYTES) {
    throw new HttpError(413, "画像を含むメッセージが大きすぎます。");
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_MESSAGE_BYTES) {
          await reader.cancel();
          throw new HttpError(413, "画像を含むメッセージが大きすぎます。");
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new Response(bytes, { headers: request.headers });
}

export async function validateImages(files: File[]): Promise<UploadedImage[]> {
  if (files.length > MAX_IMAGES)
    throw new HttpError(400, "画像は1回4枚までです。");
  const images: UploadedImage[] = [];
  for (const file of files) {
    if (!file.size || file.size > MAX_IMAGE_BYTES) {
      throw new HttpError(413, "画像は1枚2MB以下にしてください。");
    }
    const bytes = await file.arrayBuffer();
    const type = detectImageType(new Uint8Array(bytes));
    if (!type || type !== file.type) {
      throw new HttpError(400, "PNG・JPEG・WebPの画像だけを添付してください。");
    }
    images.push({
      bytes,
      attachment: {
        id: crypto.randomUUID(),
        name:
          file.name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 120) ||
          "画像",
        type,
        size: file.size,
      },
    });
  }
  return images;
}

export function detectImageType(
  bytes: Uint8Array,
): ImageAttachment["type"] | null {
  if (bytes.length < 12) return null;
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v))
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (
    new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP"
  )
    return "image/webp";
  return null;
}

export function imageKey(jobId: string, imageId: string) {
  return `attachments/${jobId}/${imageId}`;
}

export async function storeImages(
  env: AppEnv,
  jobId: string,
  images: UploadedImage[],
) {
  try {
    for (const image of images) {
      await env.CMS_AI_IMAGES.put(
        imageKey(jobId, image.attachment.id),
        image.bytes,
        {
          httpMetadata: { contentType: image.attachment.type },
        },
      );
    }
  } catch {
    await deleteImages(env, jobId, images);
    throw new HttpError(
      503,
      "画像を保存できませんでした。再試行してください。",
    );
  }
}

export async function deleteImages(
  env: AppEnv,
  jobId: string,
  images: UploadedImage[],
) {
  if (images.length)
    await env.CMS_AI_IMAGES.delete(
      images.map((i) => imageKey(jobId, i.attachment.id)),
    );
}

// Only the authenticated user's route may call this after verifying job ownership.
export async function imageResponse(env: AppEnv, job: Job, imageId: string) {
  const attachment = job.attachments.find((a) => a.id === imageId);
  if (!attachment) throw new HttpError(404, "画像が見つかりません。");
  const object = await env.CMS_AI_IMAGES.get(imageKey(job.id, attachment.id));
  if (!object) throw new HttpError(404, "画像が見つかりません。");
  return new Response(object.body, {
    headers: {
      "Content-Type": attachment.type,
      "Content-Length": String(object.size),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}

export async function imageContent(
  env: AppEnv,
  job: Job,
  text: string,
  budget: { remaining: number },
): Promise<MessageContent> {
  if (!job.attachments.length) return text;
  const content: Exclude<MessageContent, string> = [{ type: "text", text }];
  for (const attachment of job.attachments) {
    if (attachment.size > budget.remaining) {
      content.push({
        type: "text",
        text: "[古い添付画像は画像コンテキスト上限のため省略。必要なら再添付を依頼してください。]",
      });
      continue;
    }
    const object = await env.CMS_AI_IMAGES.get(imageKey(job.id, attachment.id));
    if (
      !object ||
      object.size !== attachment.size ||
      object.size > MAX_IMAGE_BYTES
    ) {
      throw new HttpError(
        422,
        "会話の添付画像を読み込めません。新しい会話で再添付してください。",
      );
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    const base64 = btoa(binary);
    budget.remaining -= object.size;
    content.push({
      type: "image_url",
      image_url: { url: `data:${attachment.type};base64,${base64}` },
    });
  }
  return content;
}
