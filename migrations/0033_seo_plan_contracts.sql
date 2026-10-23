-- New jobs only. Existing jobs permanently use plan instructions v1.
CREATE TABLE seo_plan_contracts (
 job_id TEXT PRIMARY KEY REFERENCES seo_editorial_jobs(id) DEFERRABLE INITIALLY DEFERRED,
 version INTEGER NOT NULL CHECK(version=2)
);
CREATE TRIGGER seo_plan_new_only BEFORE INSERT ON seo_plan_contracts
WHEN EXISTS(SELECT 1 FROM seo_editorial_jobs WHERE id=NEW.job_id) OR EXISTS(SELECT 1 FROM seo_plan_contracts WHERE job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'seo_plan_new_only'); END;
CREATE TRIGGER seo_plan_no_update BEFORE UPDATE ON seo_plan_contracts BEGIN SELECT RAISE(ABORT,'seo_plan_immutable'); END;
CREATE TRIGGER seo_plan_no_delete BEFORE DELETE ON seo_plan_contracts BEGIN SELECT RAISE(ABORT,'seo_plan_immutable'); END;
CREATE TRIGGER seo_plan_job_identity BEFORE UPDATE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_plan_contracts WHERE job_id=OLD.id) AND (NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id)
BEGIN SELECT RAISE(ABORT,'seo_plan_immutable'); END;
CREATE TRIGGER seo_plan_job_delete BEFORE DELETE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_plan_contracts WHERE job_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'seo_plan_immutable'); END;
CREATE TRIGGER seo_plan_job_replace BEFORE INSERT ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_plan_contracts p JOIN seo_editorial_jobs j ON j.id=p.job_id WHERE j.id=NEW.id)
BEGIN SELECT RAISE(ABORT,'seo_plan_immutable'); END;
