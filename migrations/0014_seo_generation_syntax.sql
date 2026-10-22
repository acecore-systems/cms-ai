-- Old jobs keep their original requests and acceptance behavior.
ALTER TABLE seo_editorial_jobs ADD COLUMN generation_syntax INTEGER NOT NULL DEFAULT 1 CHECK(generation_syntax IN (1,2));
CREATE TRIGGER seo_generation_syntax_immutable BEFORE UPDATE OF generation_syntax ON seo_editorial_jobs
WHEN NEW.generation_syntax IS NOT OLD.generation_syntax BEGIN SELECT RAISE(ABORT,'immutable_generation_syntax'); END;
