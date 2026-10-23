-- Existing jobs retain the original discovery prompt and receipt hashes.
ALTER TABLE seo_editorial_jobs ADD COLUMN discovery_instructions INTEGER NOT NULL DEFAULT 1 CHECK(discovery_instructions IN (1,2));
CREATE TRIGGER seo_discovery_instructions_immutable BEFORE UPDATE OF discovery_instructions ON seo_editorial_jobs WHEN NEW.discovery_instructions IS NOT OLD.discovery_instructions BEGIN SELECT RAISE(ABORT,'immutable_discovery_instructions'); END;
