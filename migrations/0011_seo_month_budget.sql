-- User approval 2026-10-22: $7/JST month; $1/run unchanged.
-- No ledger rows, reservations, deadlines or audit records are modified.
DROP TRIGGER seo_budget_cap;
CREATE TRIGGER seo_budget_cap BEFORE INSERT ON seo_budget_calls
WHEN NOT EXISTS(SELECT 1 FROM seo_budget_calls WHERE id=NEW.id)
BEGIN
  SELECT CASE WHEN NEW.reserved_micros + COALESCE((SELECT SUM(reserved_micros) FROM seo_budget_calls WHERE run_id=NEW.run_id),0) > 1000000
    THEN RAISE(ABORT,'seo_run_budget_exhausted') END;
  SELECT CASE WHEN NEW.reserved_micros + COALESCE((SELECT SUM(reserved_micros) FROM seo_budget_calls WHERE month_jst=NEW.month_jst),0) > 7000000
    THEN RAISE(ABORT,'seo_month_budget_exhausted') END;
END;
