import { afterEach, expect, it, vi } from "vitest";
import { proofObjects } from "../src/seo-proof-objects.ts";
import type { AppEnv } from "../src/env.ts";
afterEach(() => vi.useRealTimers());
it("bounds independent GET/body work at four, consumes streams once and caches only within one proof", async () => {
  vi.useFakeTimers();
  let active = 0,
    peak = 0,
    gets = 0,
    bodies = 0;
  const delay = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
  };
  const env = {
    CMS_AI_IMAGES: {
      get: async (k: string) => {
        gets++;
        await delay();
        return {
          text: async () => {
            bodies++;
            await delay();
            return JSON.stringify({ key: k });
          },
        };
      },
    },
  } as unknown as AppEnv;
  const start = Date.now(),
    one = proofObjects(env, start + 1000),
    items = Array.from({ length: 8 }, (_, i) => ({
      key: "object-" + i,
      body: true,
    }));
  const preload = one.prefetch([...items, ...items]);
  await vi.runAllTimersAsync();
  await preload;
  expect(peak).toBe(4);
  expect(gets).toBe(8);
  expect(bodies).toBe(8);
  expect(Date.now() - start).toBe(40);
  const read = await one.env.CMS_AI_IMAGES.get("object-0");
  expect(await read!.text()).toBe('{"key":"object-0"}');
  expect(await read!.text()).toBe('{"key":"object-0"}');
  const two = proofObjects(env, Date.now() + 1000),
    fresh = two.prefetch([items[0]]);
  await vi.runAllTimersAsync();
  await fresh;
  expect(gets).toBe(9);
  expect(bodies).toBe(9);
});
it("keeps missing, rejected and body-failed reads distinct without retries", async () => {
  const get = vi.fn(async (k: string) => {
    if (k === "missing") return null;
    if (k === "error") throw new Error("PRIVATE_R2_ERROR");
    return {
      text: async () => {
        throw new Error("PRIVATE_BODY_ERROR");
      },
    };
  });
  const reader = proofObjects(
    { CMS_AI_IMAGES: { get } } as unknown as AppEnv,
    Date.now() + 1000,
  );
  expect(await reader.env.CMS_AI_IMAGES.get("missing")).toBeNull();
  expect(await reader.env.CMS_AI_IMAGES.get("missing")).toBeNull();
  for (let i = 0; i < 2; i++)
    await expect(
      reader.prefetch([
        { key: "error", body: true },
        { key: "bad-body", body: true },
      ]),
    ).rejects.toThrow("PRIVATE_R2_ERROR");
  await expect(
    (await reader.env.CMS_AI_IMAGES.get("bad-body"))!.text(),
  ).rejects.toThrow("PRIVATE_BODY_ERROR");
  expect(get.mock.calls.map((x) => x[0])).toEqual([
    "missing",
    "error",
    "bad-body",
  ]);
});
it("stops queued reads at the unchanged deadline and observes every rejection", async () => {
  vi.useFakeTimers();
  const get = vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 10));
    return null;
  });
  const reader = proofObjects(
    { CMS_AI_IMAGES: { get } } as unknown as AppEnv,
    Date.now() + 5,
  );
  const done = expect(
    reader.prefetch(
      Array.from({ length: 12 }, (_, i) => ({ key: String(i), body: false })),
    ),
  ).rejects.toMatchObject({ code: "proof_read_deadline" });
  await vi.runAllTimersAsync();
  await done;
  expect(get).toHaveBeenCalledTimes(4);
});
it("bounds distinct proof objects at 32", async () => {
  const get = vi.fn(async () => null),
    reader = proofObjects(
      { CMS_AI_IMAGES: { get } } as unknown as AppEnv,
      Date.now() + 1000,
    );
  await expect(
    reader.prefetch(
      Array.from({ length: 33 }, (_, i) => ({ key: String(i), body: false })),
    ),
  ).rejects.toMatchObject({ code: "proof_read_bound" });
  expect(get).toHaveBeenCalledTimes(32);
});
