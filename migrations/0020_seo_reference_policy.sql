-- New jobs only; preserve old URL validation and immutable rejection meaning.
ALTER TABLE seo_editorial_jobs ADD COLUMN reference_policy INTEGER NOT NULL DEFAULT 1 CHECK(reference_policy IN (1,2));
CREATE TRIGGER seo_reference_policy_immutable BEFORE UPDATE OF reference_policy ON seo_editorial_jobs WHEN NEW.reference_policy IS NOT OLD.reference_policy BEGIN SELECT RAISE(ABORT,'immutable_reference_policy'); END;
