import type { AppEnv } from "./env.ts";

// Request-local only. Cache raw text, never a consumed R2 stream or parsed value.
// Failed reads stay failed; neither errors nor missing objects cause a retry.
export function proofObjects(env: AppEnv, deadline: number) {
  type ObjectText = { text(): Promise<string> } | null;
  const cache = new Map<string, Promise<ObjectText>>();
  const queue: (() => void)[] = [];
  let active = 0;
  const limited = <T>(read: () => Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const start = () => {
        active++;
        Promise.resolve()
          .then(() => {
            if (Date.now() >= deadline)
              throw Object.assign(new Error("seo_proof_read"), {
                code: "proof_read_deadline",
              });
            return read();
          })
          .then(resolve, reject)
          .finally(() => {
            active--;
            queue.shift()?.();
          });
      };
      if (active < 4) start();
      else queue.push(start);
    });
  const get = (key: string): Promise<ObjectText> => {
    const saved = cache.get(key);
    if (saved) return saved;
    if (cache.size >= 32)
      return Promise.reject(
        Object.assign(new Error("seo_proof_read"), {
          code: "proof_read_bound",
        }),
      );
    const pending = limited(async () => {
      const object = await env.CMS_AI_IMAGES.get(key);
      if (!object) return null;
      let body: Promise<string> | undefined;
      return { text: () => (body ??= limited(() => object.text())) };
    });
    cache.set(key, pending);
    return pending;
  };
  return {
    env: { ...env, CMS_AI_IMAGES: { get } } as AppEnv,
    async prefetch(items: { key: string; body: boolean }[]) {
      // Observe every scheduled rejection before returning, even on one failure.
      const results = await Promise.allSettled(
        items.map(async ({ key, body }) => {
          const object = await get(key);
          if (body && object) await object.text();
        }),
      );
      const failed = results.find((r) => r.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  };
}
