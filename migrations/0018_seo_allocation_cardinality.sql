-- Old allocations keep their exact nine-file replay; new jobs opt into 1..9.
ALTER TABLE seo_editorial_jobs ADD COLUMN allocation_version INTEGER NOT NULL DEFAULT 1 CHECK(allocation_version IN (1,2));
CREATE TRIGGER seo_allocation_version_immutable
BEFORE UPDATE OF allocation_version ON seo_editorial_jobs
WHEN NEW.allocation_version IS NOT OLD.allocation_version
BEGIN SELECT RAISE(ABORT, 'immutable_allocation_version'); END;
