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
  sql.exec(
    readFileSync(
      new URL("../migrations/0011_seo_month_budget.sql", import.meta.url),
      "utf8",
    ),
  );
  sql.exec("CREATE TABLE seo_editorial_jobs(id TEXT PRIMARY KEY)");
  sql.exec(
    readFileSync(
      new URL("../migrations/0012_seo_run_budget.sql", import.meta.url),
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
  it("fixes each new run's version and rejects mixed versions while enforcing $1.25 and $7 atomically", async () => {
    await budget.reserve(id(1), id(11), "a", hash, 900000, now, now + 60000, 2);
    await budget.finish(id(11), "unresolved");
    const results = await Promise.allSettled([
      budget.reserve(id(1), id(12), "a", hash, 350000, now, now + 60000, 2),
      budget.reserve(id(1), id(13), "a", hash, 350000, now, now + 60000, 2),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(
      budget.reserve(id(1), id(14), "a", hash, 1, now, now + 60000, 1),
    ).rejects.toThrow();
    expect(
      sql.prepare("SELECT SUM(reserved_micros) n FROM seo_budget_calls").get()!
        .n,
    ).toBe(1250000);
    expect(() =>
      sql.exec("UPDATE seo_budget_runs SET run_limit_micros=1000000"),
    ).toThrow("immutable_run_limit");
    for (let i = 2; i <= 6; i++)
      await budget.reserve(
        id(i),
        id(i + 20),
        "a",
        hash,
        1000000,
        now,
        now + 60000,
        2,
      );
    await budget.reserve(id(7), id(27), "a", hash, 750000, now, now + 60000, 2);
    await expect(
      budget.reserve(id(8), id(28), "a", hash, 1, now, now + 60000, 2),
    ).rejects.toThrow("seo_month_budget_exhausted");
  });
  it("migration keeps every old column and assigns immutable legacy defaults", () => {
    const legacy = new DatabaseSync(":memory:");
    try {
      legacy.exec(
        readFileSync(
          new URL("../migrations/0004_seo_budget.sql", import.meta.url),
          "utf8",
        ),
      );
      legacy.exec(
        "CREATE TABLE seo_editorial_jobs(id TEXT PRIMARY KEY,status TEXT); INSERT INTO seo_editorial_jobs VALUES('old','unresolved'); INSERT INTO seo_budget_runs VALUES('old','article',1,2); INSERT INTO seo_budget_calls VALUES('call','old','2026-10','hash',123,'unresolved',1)",
      );
      const before = legacy.prepare("SELECT * FROM seo_budget_calls").all();
      legacy.exec(
        readFileSync(
          new URL("../migrations/0012_seo_run_budget.sql", import.meta.url),
          "utf8",
        ),
      );
      expect(legacy.prepare("SELECT * FROM seo_budget_calls").all()).toEqual(
        before,
      );
      expect(legacy.prepare("SELECT * FROM seo_budget_runs").get()).toEqual({
        id: "old",
        article_key: "article",
        created_at: 1,
        deadline: 2,
        run_limit_micros: 1000000,
      });
      expect(legacy.prepare("SELECT * FROM seo_editorial_jobs").get()).toEqual({
        id: "old",
        status: "unresolved",
        budget_version: 1,
      });
      expect(() =>
        legacy.exec("UPDATE seo_editorial_jobs SET budget_version=2"),
      ).toThrow("immutable_budget_version");
      expect(() =>
        legacy.exec("UPDATE seo_budget_runs SET run_limit_micros=1250000"),
      ).toThrow("immutable_run_limit");
    } finally {
      legacy.close();
    }
  });
  it("upgrades the monthly trigger without changing prior complete/unknown reservations or deadlines", async () => {
    sql.exec("DROP TRIGGER seo_budget_cap");
    const original = readFileSync(
      new URL("../migrations/0004_seo_budget.sql", import.meta.url),
      "utf8",
    );
    sql.exec(original.slice(original.indexOf("CREATE TRIGGER seo_budget_cap")));
    for (let i = 1; i <= 5; i++) {
      await budget.reserve(id(i), id(i + 10), "a", hash, 1_000_000, now);
      await budget.finish(id(i + 10), i === 1 ? "unresolved" : "complete");
    }
    const runs = sql.prepare("SELECT * FROM seo_budget_runs ORDER BY id").all();
    const calls = sql
      .prepare("SELECT * FROM seo_budget_calls ORDER BY id")
      .all();
    await expect(
      budget.reserve(id(6), id(16), "a", hash, 1, now),
    ).rejects.toThrow("seo_month_budget_exhausted");
    sql.exec(
      readFileSync(
        new URL("../migrations/0011_seo_month_budget.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(
      sql.prepare("SELECT * FROM seo_budget_runs ORDER BY id").all(),
    ).toEqual(runs);
    expect(
      sql.prepare("SELECT * FROM seo_budget_calls ORDER BY id").all(),
    ).toEqual(calls);
    await budget.reserve(id(6), id(16), "a", hash, 1_000_000, now);
    await budget.reserve(id(7), id(17), "a", hash, 1_000_000, now);
    await expect(
      budget.reserve(id(8), id(18), "a", hash, 1, now),
    ).rejects.toThrow("seo_month_budget_exhausted");
    await expect(
      budget.reserve(id(1), id(19), "a", hash, 1, now),
    ).rejects.toThrow("seo_run_budget_exhausted");
  });
  it("uses the supplied absolute deadline and cannot extend it across API calls", async () => {
    await budget.reserve(id(1), id(11), "a", hash, 100, now, now + 60_000);
    await budget.reserve(
      id(1),
      id(12),
      "a",
      hash,
      100,
      now + 30_000,
      now + 120_000,
    );
    expect(
      sql.prepare("SELECT deadline FROM seo_budget_runs").get()?.deadline,
    ).toBe(now + 60_000);
    await expect(
      budget.reserve(
        id(1),
        id(13),
        "a",
        hash,
        100,
        now + 60_000,
        now + 120_000,
      ),
    ).rejects.toThrow();
    await expect(
      budget.reserve(id(2), id(14), "a", hash, 100, now, now + 31 * 60_000),
    ).rejects.toThrow();
  });
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
  it("enforces $7/month across runs and uses JST month boundaries", async () => {
    for (let i = 1; i <= 7; i++)
      await budget.reserve(id(i), id(i + 10), "a", hash, 1_000_000, now);
    await expect(
      budget.reserve(id(8), id(18), "a", hash, 1, now),
    ).rejects.toThrow();
    const next = Date.parse("2026-10-31T15:00:00Z");
    expect(jstMonth(next - 1)).toBe("2026-10");
    expect(jstMonth(next)).toBe("2026-11");
    await budget.reserve(id(8), id(18), "a", hash, 1_000_000, next);
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
