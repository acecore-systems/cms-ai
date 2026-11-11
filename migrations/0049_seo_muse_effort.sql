-- New v5 jobs only; old medium generation contracts and audits stay unchanged.
CREATE TABLE seo_v5_effort_contracts (
 job_id TEXT PRIMARY KEY NOT NULL REFERENCES seo_editorial_jobs(id) DEFERRABLE INITIALLY DEFERRED,
 version INTEGER NOT NULL CHECK(version=1),
 generation_version INTEGER NOT NULL CHECK(generation_version=2),
 max_completion_tokens INTEGER NOT NULL CHECK(max_completion_tokens=48000),
 generation_effort TEXT NOT NULL CHECK(generation_effort='max')
);
CREATE TRIGGER seo_v5_effort_new_only BEFORE INSERT ON seo_v5_effort_contracts
WHEN EXISTS(SELECT 1 FROM seo_editorial_jobs WHERE id=NEW.job_id)
 OR EXISTS(SELECT 1 FROM seo_v5_effort_contracts WHERE job_id=NEW.job_id)
 OR EXISTS(SELECT 1 FROM seo_v5_generation_contracts WHERE job_id=NEW.job_id)
 OR EXISTS(SELECT 1 FROM seo_generation_contracts WHERE job_id=NEW.job_id)
 OR EXISTS(SELECT 1 FROM seo_muse_generation_contracts WHERE job_id=NEW.job_id)
 OR NOT EXISTS(SELECT 1 FROM seo_v5_job_models WHERE job_id=NEW.job_id AND version=5)
BEGIN SELECT RAISE(ABORT,'seo_v5_effort_new_only'); END;
CREATE TRIGGER seo_v5_effort_no_update BEFORE UPDATE ON seo_v5_effort_contracts BEGIN SELECT RAISE(ABORT,'seo_v5_effort_immutable'); END;
CREATE TRIGGER seo_v5_effort_no_delete BEFORE DELETE ON seo_v5_effort_contracts BEGIN SELECT RAISE(ABORT,'seo_v5_effort_immutable'); END;
CREATE TRIGGER seo_v5_effort_no_legacy BEFORE INSERT ON seo_v5_generation_contracts WHEN EXISTS(SELECT 1 FROM seo_v5_effort_contracts WHERE job_id=NEW.job_id) BEGIN SELECT RAISE(ABORT,'seo_generation_conflict'); END;
CREATE TRIGGER seo_effort_no_generation BEFORE INSERT ON seo_generation_contracts WHEN EXISTS(SELECT 1 FROM seo_v5_effort_contracts WHERE job_id=NEW.job_id) BEGIN SELECT RAISE(ABORT,'seo_generation_conflict'); END;
CREATE TRIGGER seo_effort_no_muse_generation BEFORE INSERT ON seo_muse_generation_contracts WHEN EXISTS(SELECT 1 FROM seo_v5_effort_contracts WHERE job_id=NEW.job_id) BEGIN SELECT RAISE(ABORT,'seo_generation_conflict'); END;
