-- User approval 2026-10-23: October 2026 JST only $11.14; every other month $7.
-- No ledger rows, run limits, reservations, deadlines or audit records change.
DROP TRIGGER seo_budget_cap;
CREATE TRIGGER seo_budget_cap BEFORE INSERT ON seo_budget_calls
WHEN NOT EXISTS(SELECT 1 FROM seo_budget_calls WHERE id=NEW.id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM seo_budget_runs WHERE id=NEW.run_id)
  THEN RAISE(ABORT,'seo_budget_run_missing') END;
 SELECT CASE WHEN NEW.reserved_micros + COALESCE((SELECT SUM(reserved_micros) FROM seo_budget_calls WHERE run_id=NEW.run_id),0) > (SELECT run_limit_micros FROM seo_budget_runs WHERE id=NEW.run_id)
  THEN RAISE(ABORT,'seo_run_budget_exhausted') END;
 SELECT CASE WHEN NEW.reserved_micros + COALESCE((SELECT SUM(reserved_micros) FROM seo_budget_calls WHERE month_jst=NEW.month_jst),0) > CASE WHEN NEW.month_jst = '2026-10' THEN 11140000 ELSE 7000000 END
  THEN RAISE(ABORT,'seo_month_budget_exhausted') END;
END;
