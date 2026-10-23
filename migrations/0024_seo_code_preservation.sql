-- Existing jobs keep the original code-copy prompt and proposal interpretation.
ALTER TABLE seo_editorial_jobs ADD COLUMN code_preservation INTEGER NOT NULL DEFAULT 1 CHECK(code_preservation IN (1,2));
CREATE TRIGGER seo_code_preservation_immutable BEFORE UPDATE OF code_preservation ON seo_editorial_jobs WHEN NEW.code_preservation IS NOT OLD.code_preservation BEGIN SELECT RAISE(ABORT,'immutable_code_preservation'); END;
