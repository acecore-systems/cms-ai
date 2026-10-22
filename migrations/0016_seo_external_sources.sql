-- Preserve v1-v3 replay, requests and existing jobs. New jobs alone use scope v4.
ALTER TABLE seo_editorial_jobs ADD COLUMN external_sources INTEGER NOT NULL DEFAULT 0 CHECK(external_sources IN (0,1));
CREATE TRIGGER seo_external_sources_immutable BEFORE UPDATE OF external_sources ON seo_editorial_jobs
WHEN NEW.external_sources IS NOT OLD.external_sources BEGIN SELECT RAISE(ABORT,'immutable_external_sources'); END;
