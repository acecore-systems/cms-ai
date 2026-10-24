-- New jobs only. Existing jobs permanently use source recovery v1.
CREATE TABLE seo_source_recovery_contracts (
 job_id TEXT PRIMARY KEY REFERENCES seo_editorial_jobs(id) DEFERRABLE INITIALLY DEFERRED,
 version INTEGER NOT NULL CHECK(version=2)
);
CREATE TRIGGER seo_source_recovery_new_only BEFORE INSERT ON seo_source_recovery_contracts
WHEN EXISTS(SELECT 1 FROM seo_editorial_jobs WHERE id=NEW.job_id) OR EXISTS(SELECT 1 FROM seo_source_recovery_contracts WHERE job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'seo_source_recovery_new_only'); END;
CREATE TRIGGER seo_source_recovery_no_update BEFORE UPDATE ON seo_source_recovery_contracts BEGIN SELECT RAISE(ABORT,'seo_source_recovery_immutable'); END;
CREATE TRIGGER seo_source_recovery_no_delete BEFORE DELETE ON seo_source_recovery_contracts BEGIN SELECT RAISE(ABORT,'seo_source_recovery_immutable'); END;
CREATE TRIGGER seo_source_recovery_job_identity BEFORE UPDATE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_source_recovery_contracts WHERE job_id=OLD.id) AND (NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id)
BEGIN SELECT RAISE(ABORT,'seo_source_recovery_immutable'); END;
CREATE TRIGGER seo_source_recovery_job_delete BEFORE DELETE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_source_recovery_contracts WHERE job_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'seo_source_recovery_immutable'); END;
CREATE TRIGGER seo_source_recovery_job_replace BEFORE INSERT ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_source_recovery_contracts p JOIN seo_editorial_jobs j ON j.id=p.job_id WHERE j.id=NEW.id)
BEGIN SELECT RAISE(ABORT,'seo_source_recovery_immutable'); END;

CREATE TABLE seo_source_recovery_results (
 job_id TEXT PRIMARY KEY REFERENCES seo_source_recovery_contracts(job_id),
 proof_sha256 TEXT NOT NULL CHECK(length(proof_sha256)=64)
);
CREATE TRIGGER seo_source_recovery_result_new BEFORE INSERT ON seo_source_recovery_results
WHEN EXISTS(SELECT 1 FROM seo_source_recovery_results WHERE job_id=NEW.job_id)
 OR NOT EXISTS(SELECT 1 FROM seo_editorial_jobs j JOIN seo_editorial_runs r ON r.run_id=j.run_id JOIN seo_editorial_checks c ON c.job_id=j.id WHERE j.id=NEW.job_id AND r.status='pending' AND c.phase='research' AND c.status='started')
BEGIN SELECT RAISE(ABORT,'seo_source_recovery_immutable'); END;
CREATE TRIGGER seo_source_recovery_result_update BEFORE UPDATE ON seo_source_recovery_results BEGIN SELECT RAISE(ABORT,'seo_source_recovery_immutable'); END;
CREATE TRIGGER seo_source_recovery_result_delete BEFORE DELETE ON seo_source_recovery_results BEGIN SELECT RAISE(ABORT,'seo_source_recovery_immutable'); END;
