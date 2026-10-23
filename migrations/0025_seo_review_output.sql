-- Existing jobs retain their original review request, cap and receipt interpretation.
ALTER TABLE seo_editorial_jobs ADD COLUMN review_output INTEGER NOT NULL DEFAULT 1 CHECK(review_output IN (1,2));
CREATE TRIGGER seo_review_output_immutable BEFORE UPDATE OF review_output ON seo_editorial_jobs WHEN NEW.review_output IS NOT OLD.review_output BEGIN SELECT RAISE(ABORT,'immutable_review_output'); END;
