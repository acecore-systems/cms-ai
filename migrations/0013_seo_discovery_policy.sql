-- Preserve existing jobs and raw replay rules; only new jobs opt into policy 3.
ALTER TABLE seo_editorial_jobs ADD COLUMN discovery_policy INTEGER NOT NULL DEFAULT 2 CHECK(discovery_policy IN (2,3));
CREATE TRIGGER seo_discovery_policy_immutable BEFORE UPDATE OF discovery_policy ON seo_editorial_jobs
WHEN NEW.discovery_policy IS NOT OLD.discovery_policy BEGIN SELECT RAISE(ABORT,'immutable_discovery_policy'); END;
