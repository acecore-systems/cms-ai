-- Existing rows retain their original $1/run and allocation contract.
ALTER TABLE seo_budget_runs ADD COLUMN run_limit_micros INTEGER NOT NULL DEFAULT 1000000 CHECK(run_limit_micros IN (1000000,1250000));
ALTER TABLE seo_editorial_jobs ADD COLUMN budget_version INTEGER NOT NULL DEFAULT 1 CHECK(budget_version IN (1,2));
CREATE TRIGGER seo_run_limit_immutable BEFORE UPDATE OF run_limit_micros ON seo_budget_runs
WHEN NEW.run_limit_micros IS NOT OLD.run_limit_micros BEGIN SELECT RAISE(ABORT,'immutable_run_limit'); END;
CREATE TRIGGER seo_job_budget_immutable BEFORE UPDATE OF budget_version ON seo_editorial_jobs
WHEN NEW.budget_version IS NOT OLD.budget_version BEGIN SELECT RAISE(ABORT,'immutable_budget_version'); END;
DROP TRIGGER seo_budget_cap;
CREATE TRIGGER seo_budget_cap BEFORE INSERT ON seo_budget_calls
WHEN NOT EXISTS(SELECT 1 FROM seo_budget_calls WHERE id=NEW.id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM seo_budget_runs WHERE id=NEW.run_id)
  THEN RAISE(ABORT,'seo_budget_run_missing') END;
 SELECT CASE WHEN NEW.reserved_micros + COALESCE((SELECT SUM(reserved_micros) FROM seo_budget_calls WHERE run_id=NEW.run_id),0) > (SELECT run_limit_micros FROM seo_budget_runs WHERE id=NEW.run_id)
  THEN RAISE(ABORT,'seo_run_budget_exhausted') END;
 SELECT CASE WHEN NEW.reserved_micros + COALESCE((SELECT SUM(reserved_micros) FROM seo_budget_calls WHERE month_jst=NEW.month_jst),0) > 7000000
  THEN RAISE(ABORT,'seo_month_budget_exhausted') END;
END;
