-- Every existing job retains its original prompts, selection and cost caps.
ALTER TABLE seo_editorial_jobs ADD COLUMN research_recovery INTEGER NOT NULL DEFAULT 1 CHECK(research_recovery IN (1,2));
CREATE TRIGGER seo_research_recovery_immutable BEFORE UPDATE OF research_recovery ON seo_editorial_jobs WHEN NEW.research_recovery IS NOT OLD.research_recovery BEGIN SELECT RAISE(ABORT,'immutable_research_recovery'); END;
