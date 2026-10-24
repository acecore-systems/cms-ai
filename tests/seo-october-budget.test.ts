import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import {
  jstMonth,
  monthBudgetMicros,
  newJobMonthLimit,
} from "../src/seo-budget.ts";

const migration = (name: string) =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
function setup() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((n) => n.endsWith(".sql") && n >= "0004" && n < "0035")
    .sort())
    db.exec(migration(name));
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
  ["2026-09-30T15:00:00.000Z", "2026-10", 12100000],
  ["2026-10-31T14:59:59.999Z", "2026-10", 12100000],
  ["2026-10-31T15:00:00.000Z", "2026-11", 7000000],
  ["2027-09-30T15:00:00.000Z", "2027-10", 7000000],
])("agrees between preflight and SQL at %s", (time, month, cap) => {
  expect(jstMonth(Date.parse(String(time)))).toBe(month);
  expect(monthBudgetMicros(String(month))).toBe(cap);
  const db = setup();
  try {
    db.exec(migration("0035_seo_october_budget_1210.sql"));
    for (let i = 0, remaining = Number(cap); remaining > 0; i++) {
      const amount = Math.min(remaining, 1000000);
      call(db, `run${i}`, String(month), amount);
      remaining -= amount;
    }
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
    db.exec(migration("0035_seo_october_budget_1210.sql"));
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
  expect(9386313 + 1249533 + 1250000).toBeLessThanOrEqual(12100000);
});

it("changes only the three approved trigger literals and keeps the exact weekly reserve", () => {
  const db = setup();
  try {
    const before = db
      .prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name",
      )
      .all();
    db.exec(migration("0035_seo_october_budget_1210.sql"));
    const changed: string[] = [];
    for (const row of before) {
      const after = db
        .prepare("SELECT type,name,sql FROM sqlite_master WHERE name=?")
        .get(row.name!);
      if (after?.sql !== row.sql) {
        changed.push(String(row.name));
        expect(after?.sql).toBe(
          String(row.sql)
            .replaceAll("11890000", "12100000")
            .replaceAll("10640000", "10850000"),
        );
      }
    }
    expect(changed).toEqual([
      "seo_budget_cap",
      "seo_fallback_first_call_fit",
      "seo_model_reservation",
    ]);
    const beforeSlot = Date.parse("2026-10-26T00:00:00Z") - 1;
    expect(newJobMonthLimit("2026-10", beforeSlot)).toBe(10850000);
    expect(
      monthBudgetMicros("2026-10") - newJobMonthLimit("2026-10", beforeSlot),
    ).toBe(1250000);
    expect(newJobMonthLimit("2026-10", beforeSlot) - 9707766).toBe(1142234);
    expect(newJobMonthLimit("2026-10", beforeSlot) - 9707766 - 1138828).toBe(
      3406,
    );
  } finally {
    db.close();
  }
});

it.each([0, 1])(
  "fallback first-call full-stage maximum observes the October boundary (+%s)",
  (excess) => {
    const db = setup();
    try {
      db.exec(migration("0035_seo_october_budget_1210.sql"));
      const maximum = 1138828;
      for (let i = 0, left = 12100000 - maximum + excess; left > 0; i++) {
        const n = Math.min(left, 1000000);
        call(db, "held" + i, "2026-10", n);
        left -= n;
      }
      db.exec(
        "INSERT INTO seo_fallback_trials VALUES('root',1,1,2); INSERT INTO seo_fallback_attempts VALUES('root','root',1,'budget','article',NULL,1);",
      );
      db.exec(
        "INSERT INTO seo_editorial_runs(run_id,budget_run_id,input_sha256,deadline,candidates_json,created_at) VALUES('root','budget','hash',2,'[{}]',1); INSERT INTO seo_editorial_jobs(id,run_id,site_id,candidate_index,status) VALUES('job','root','wiki',0,'inspecting'); UPDATE seo_editorial_runs SET job_id='job' WHERE run_id='root';",
      );
      db.exec(
        `INSERT INTO seo_fallback_preflights VALUES('job',${maximum},'{}',1);`,
      );
      if (excess)
        expect(() => call(db, "first", "2026-10", 1, "budget")).toThrow(
          "seo_fallback_preflight_changed",
        );
      else
        expect(() => call(db, "first", "2026-10", 1, "budget")).not.toThrow();
    } finally {
      db.close();
    }
  },
);
