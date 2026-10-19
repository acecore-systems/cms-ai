-- SEO has its own USD ledger; existing interactive CMS calls do not use it.
CREATE TABLE seo_budget_runs (
  id TEXT PRIMARY KEY,
  article_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deadline INTEGER NOT NULL
);
CREATE TABLE seo_budget_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES seo_budget_runs(id),
  month_jst TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  reserved_micros INTEGER NOT NULL CHECK(reserved_micros BETWEEN 1 AND 1000000),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','complete','unresolved')),
  created_at INTEGER NOT NULL
);
CREATE INDEX seo_budget_month ON seo_budget_calls(month_jst);
CREATE INDEX seo_budget_run ON seo_budget_calls(run_id);
CREATE TRIGGER seo_budget_cap BEFORE INSERT ON seo_budget_calls
WHEN NOT EXISTS(SELECT 1 FROM seo_budget_calls WHERE id=NEW.id)
BEGIN
  SELECT CASE WHEN NEW.reserved_micros + COALESCE((SELECT SUM(reserved_micros) FROM seo_budget_calls WHERE run_id=NEW.run_id),0) > 1000000
    THEN RAISE(ABORT,'seo_run_budget_exhausted') END;
  SELECT CASE WHEN NEW.reserved_micros + COALESCE((SELECT SUM(reserved_micros) FROM seo_budget_calls WHERE month_jst=NEW.month_jst),0) > 5000000
    THEN RAISE(ABORT,'seo_month_budget_exhausted') END;
END;
