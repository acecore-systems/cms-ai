-- New jobs only. Existing jobs permanently use research focus v1.
CREATE TABLE seo_research_focus_contracts (
 job_id TEXT PRIMARY KEY REFERENCES seo_editorial_jobs(id) DEFERRABLE INITIALLY DEFERRED,
 version INTEGER NOT NULL CHECK(version=2)
);
CREATE TRIGGER seo_research_focus_new_only BEFORE INSERT ON seo_research_focus_contracts
WHEN EXISTS(SELECT 1 FROM seo_editorial_jobs WHERE id=NEW.job_id) OR EXISTS(SELECT 1 FROM seo_research_focus_contracts WHERE job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'seo_research_focus_new_only'); END;
CREATE TRIGGER seo_research_focus_no_update BEFORE UPDATE ON seo_research_focus_contracts BEGIN SELECT RAISE(ABORT,'seo_research_focus_immutable'); END;
CREATE TRIGGER seo_research_focus_no_delete BEFORE DELETE ON seo_research_focus_contracts BEGIN SELECT RAISE(ABORT,'seo_research_focus_immutable'); END;
CREATE TRIGGER seo_research_focus_job_identity BEFORE UPDATE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_research_focus_contracts WHERE job_id=OLD.id) AND (NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id)
BEGIN SELECT RAISE(ABORT,'seo_research_focus_immutable'); END;
CREATE TRIGGER seo_research_focus_job_delete BEFORE DELETE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_research_focus_contracts WHERE job_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'seo_research_focus_immutable'); END;
CREATE TRIGGER seo_research_focus_job_replace BEFORE INSERT ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_research_focus_contracts p JOIN seo_editorial_jobs j ON j.id=p.job_id WHERE j.id=NEW.id)
BEGIN SELECT RAISE(ABORT,'seo_research_focus_immutable'); END;
