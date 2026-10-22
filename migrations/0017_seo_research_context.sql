-- Preserve the exact low-context request for existing jobs, including terminal jobs.
ALTER TABLE seo_editorial_jobs ADD COLUMN research_context TEXT NOT NULL DEFAULT 'low' CHECK(research_context IN ('low','high'));
CREATE TRIGGER seo_research_context_immutable
BEFORE UPDATE OF research_context ON seo_editorial_jobs
WHEN NEW.research_context IS NOT OLD.research_context
BEGIN SELECT RAISE(ABORT, 'immutable_research_context'); END;
