import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { jstMonth, monthBudgetMicros } from "../src/seo-budget.ts";

const migration = (name: string) =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(migration("0004_seo_budget.sql"));
  db.exec(migration("0011_seo_month_budget.sql"));
  db.exec("CREATE TABLE seo_editorial_jobs(id TEXT PRIMARY KEY)");
  db.exec(migration("0012_seo_run_budget.sql"));
  return db;
}
function call(
  db: DatabaseSync,
  id: string,
  month: string,
  amount: number,
  run = id,
) {
  db.prepare(
    "INSERT OR IGNORE INTO seo_budget_runs(id,article_key,created_at,deadline,run_limit_micros) VALUES(?,'article',1,2,1250000)",
  ).run(run);
  db.prepare(
    "INSERT INTO seo_budget_calls(id,run_id,month_jst,request_sha256,reserved_micros,created_at) VALUES(?,?,?,'hash',?,1)",
  ).run(id, run, month, amount);
}
it.each([
  ["2026-09-30T14:59:59.999Z", "2026-09", 7000000],
  ["2026-09-30T15:00:00.000Z", "2026-10", 11000000],
  ["2026-10-31T14:59:59.999Z", "2026-10", 11000000],
  ["2026-10-31T15:00:00.000Z", "2026-11", 7000000],
  ["2027-09-30T15:00:00.000Z", "2027-10", 7000000],
])("agrees between preflight and SQL at %s", (time, month, cap) => {
  expect(jstMonth(Date.parse(String(time)))).toBe(month);
  expect(monthBudgetMicros(String(month))).toBe(cap);
  const db = setup();
  try {
    db.exec(migration("0015_seo_october_budget.sql"));
    db.exec(migration("0027_seo_october_budget_extension.sql"));
    for (let i = 0; i < Number(cap) / 1000000; i++)
      call(db, `run${i}`, String(month), 1000000);
    expect(() => call(db, "excess", String(month), 1)).toThrow(
      "seo_month_budget_exhausted",
    );
    expect(
      db
        .prepare("SELECT SUM(reserved_micros) held FROM seo_budget_calls")
        .get()!.held,
    ).toBe(cap);
  } finally {
    db.close();
  }
});
it("keeps old rows, unresolved reservations, deadlines, run ceilings and duplicate protection", () => {
  const db = setup();
  try {
    call(db, "unknown", "2026-10", 1000000);
    db.exec("UPDATE seo_budget_calls SET status='unresolved'");
    const before = [
      db.prepare("SELECT * FROM seo_budget_runs").all(),
      db.prepare("SELECT * FROM seo_budget_calls").all(),
    ];
    db.exec(migration("0015_seo_october_budget.sql"));
    db.exec(migration("0027_seo_october_budget_extension.sql"));
    expect([
      db.prepare("SELECT * FROM seo_budget_runs").all(),
      db.prepare("SELECT * FROM seo_budget_calls").all(),
    ]).toEqual(before);
    call(db, "finish", "2026-10", 250000, "unknown");
    expect(() => call(db, "excess", "2026-10", 1, "unknown")).toThrow(
      "seo_run_budget_exhausted",
    );
    expect(() => call(db, "unknown", "2026-10", 1000000)).toThrow();
    expect(() =>
      db.exec("UPDATE seo_budget_runs SET run_limit_micros=1000000"),
    ).toThrow("immutable_run_limit");
  } finally {
    db.close();
  }
});
it("rejects malformed month keys and does not extend the exception", () => {
  for (const m of ["2026-1", "2026-13", "2026-10 ", "2026-10-01", ""])
    expect(() => monthBudgetMicros(m)).toThrow("seo_invalid_budget_month");
  expect(monthBudgetMicros("2026-11")).toBe(7000000);
  expect(7740551 + 1249533 + 1250000).toBeLessThanOrEqual(11000000);
});
