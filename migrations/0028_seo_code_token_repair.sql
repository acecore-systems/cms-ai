-- Existing jobs retain strict code token interpretation and all saved evidence.
ALTER TABLE seo_editorial_jobs ADD COLUMN code_token_repair INTEGER NOT NULL DEFAULT 1 CHECK(code_token_repair IN (1,2));
CREATE TRIGGER seo_code_token_repair_immutable BEFORE UPDATE OF code_token_repair ON seo_editorial_jobs WHEN NEW.code_token_repair IS NOT OLD.code_token_repair BEGIN SELECT RAISE(ABORT,'immutable_code_token_repair'); END;
