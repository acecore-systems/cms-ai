-- Preserve every existing job's original discovery/retrieval prompt.
ALTER TABLE seo_editorial_jobs ADD COLUMN url_instructions INTEGER NOT NULL DEFAULT 1 CHECK(url_instructions IN (1,2));
CREATE TRIGGER seo_url_instructions_immutable BEFORE UPDATE OF url_instructions ON seo_editorial_jobs WHEN NEW.url_instructions IS NOT OLD.url_instructions BEGIN SELECT RAISE(ABORT,'immutable_url_instructions'); END;
