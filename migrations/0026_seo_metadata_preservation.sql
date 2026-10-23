-- Existing jobs keep their original full-frontmatter generation and proposal interpretation.
ALTER TABLE seo_editorial_jobs ADD COLUMN metadata_preservation INTEGER NOT NULL DEFAULT 1 CHECK(metadata_preservation IN (1,2));
CREATE TRIGGER seo_metadata_preservation_immutable BEFORE UPDATE OF metadata_preservation ON seo_editorial_jobs WHEN NEW.metadata_preservation IS NOT OLD.metadata_preservation BEGIN SELECT RAISE(ABORT,'immutable_metadata_preservation'); END;
