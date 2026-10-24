-- New jobs only: legacy jobs permanently retain the 12,000-token generation request.
CREATE TABLE seo_generation_contracts (
 job_id TEXT PRIMARY KEY NOT NULL REFERENCES seo_editorial_jobs(id) DEFERRABLE INITIALLY DEFERRED,
 version INTEGER NOT NULL CHECK(version=2),
 max_completion_tokens INTEGER NOT NULL CHECK(max_completion_tokens=48000),
 reasoning_effort TEXT NOT NULL CHECK(reasoning_effort='high')
);
CREATE TRIGGER seo_generation_new_only BEFORE INSERT ON seo_generation_contracts
WHEN EXISTS(SELECT 1 FROM seo_editorial_jobs WHERE id=NEW.job_id) OR EXISTS(SELECT 1 FROM seo_generation_contracts WHERE job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'seo_generation_new_only'); END;
CREATE TRIGGER seo_generation_no_update BEFORE UPDATE ON seo_generation_contracts BEGIN SELECT RAISE(ABORT,'seo_generation_immutable'); END;
CREATE TRIGGER seo_generation_no_delete BEFORE DELETE ON seo_generation_contracts BEGIN SELECT RAISE(ABORT,'seo_generation_immutable'); END;
CREATE TRIGGER seo_generation_job_identity BEFORE UPDATE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_generation_contracts WHERE job_id=OLD.id) AND (NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id)
BEGIN SELECT RAISE(ABORT,'seo_generation_immutable'); END;
CREATE TRIGGER seo_generation_job_delete BEFORE DELETE ON seo_editorial_jobs WHEN EXISTS(SELECT 1 FROM seo_generation_contracts WHERE job_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'seo_generation_immutable'); END;
CREATE TRIGGER seo_generation_job_replace BEFORE INSERT ON seo_editorial_jobs WHEN EXISTS(SELECT 1 FROM seo_generation_contracts g JOIN seo_editorial_jobs j ON j.id=g.job_id WHERE j.id=NEW.id)
BEGIN SELECT RAISE(ABORT,'seo_generation_immutable'); END;

CREATE TRIGGER seo_generation_model_required BEFORE INSERT ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_generation_contracts WHERE job_id=NEW.id) AND NOT EXISTS(SELECT 1 FROM seo_job_models WHERE job_id=NEW.id AND version=2)
BEGIN SELECT RAISE(ABORT,'seo_generation_model_required'); END;
