import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SeoBudget,
  upperCost,
  jstMonth,
  RATE_VALID_UNTIL,
} from "../src/seo-budget.ts";
import type { AppEnv } from "../src/env.ts";

let sql: DatabaseSync;
let budget: SeoBudget;
const now = Date.parse("2026-10-19T00:00:00Z");
const id = (n: number) =>
  "seo-00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const hash = "a".repeat(64);
beforeEach(() => {
  sql = new DatabaseSync(":memory:");
  sql.exec(
    readFileSync(
      new URL("../migrations/0004_seo_budget.sql", import.meta.url),
      "utf8",
    ),
  );
  const prepare = (query: string) => ({
    bind: (...args: (string | number)[]) => ({
      run: async () => ({
        meta: { changes: Number(sql.prepare(query).run(...args).changes) },
      }),
      query,
      args,
    }),
  });
  const db = {
    prepare,
    batch: async (items: { query: string; args: (string | number)[] }[]) => {
      sql.exec("BEGIN");
      try {
        const result = items.map((x) => ({
          meta: {
            changes: Number(sql.prepare(x.query).run(...x.args).changes),
          },
        }));
        sql.exec("COMMIT");
        return result;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as AppEnv["CMS_AI_DB"];
  budget = new SeoBudget(db);
});
afterEach(() => sql.close());
describe("SEO persistent budget", () => {
  it("blocks concurrent requests past $1/run and keeps unknown reservations", async () => {
    const results = await Promise.allSettled([
      budget.reserve(id(1), id(11), "a", hash, 600_000, now),
      budget.reserve(id(1), id(12), "a", hash, 600_000, now),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    await budget.finish(id(11), "unresolved");
    await expect(
      budget.reserve(id(1), id(13), "a", hash, 500_000, now),
    ).rejects.toThrow();
    await budget.reserve(id(1), id(14), "a", hash, 400_000, now);
  });
  it("enforces $5/month across runs and uses JST month boundaries", async () => {
    for (let i = 1; i <= 5; i++)
      await budget.reserve(id(i), id(i + 10), "a", hash, 1_000_000, now);
    await expect(
      budget.reserve(id(6), id(16), "a", hash, 1, now),
    ).rejects.toThrow();
    const next = Date.parse("2026-10-31T15:00:00Z");
    expect(jstMonth(next - 1)).toBe("2026-10");
    expect(jstMonth(next)).toBe("2026-11");
    await budget.reserve(id(6), id(16), "a", hash, 1_000_000, next);
  });
  it("cannot reuse a call, switch article, or extend a run deadline", async () => {
    await budget.reserve(id(1), id(11), "a", hash, 10, now);
    await budget.finish(id(11), "complete");
    await expect(
      budget.reserve(id(1), id(11), "a", hash, 10, now),
    ).rejects.toThrow();
    await expect(
      budget.reserve(id(1), id(12), "b", hash, 10, now),
    ).rejects.toThrow();
    await expect(
      budget.reserve(id(1), id(12), "a", hash, 10, now + 30 * 60_000),
    ).rejects.toThrow();
    expect(
      sql.prepare("SELECT COUNT(*) AS n FROM seo_budget_calls").get()?.n,
    ).toBe(1);
  });
  it("rejects another model, nonstandard tier, oversized output and stale rates", () => {
    const request = {
      max_completion_tokens: 12_000,
      service_tier: "default",
      messages: [{ role: "user", content: "日本語" }],
    };
    expect(upperCost("gpt-6-luna", request, now)).toBeGreaterThan(32_000);
    for (const [model, payload, time] of [
      ["other", request, now],
      ["gpt-6-luna", { ...request, service_tier: "priority" }, now],
      ["gpt-6-luna", { ...request, max_completion_tokens: 12001 }, now],
      ["gpt-6-luna", request, RATE_VALID_UNTIL],
    ] as const)
      expect(() => upperCost(model, payload, time)).toThrow();
  });
});
