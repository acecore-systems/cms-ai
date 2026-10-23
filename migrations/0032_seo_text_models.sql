-- Registration precedes creation of a NEW job in the same D1 transaction.
-- Absence is permanently the legacy Luna contract; no old job is backfilled.
CREATE TABLE seo_job_models (
 job_id TEXT PRIMARY KEY,
 version INTEGER NOT NULL CHECK(version=2),
 text_model TEXT NOT NULL CHECK(text_model='@cf/deepseek-ai/deepseek-v4.1-flash-1017'),
 search_model TEXT NOT NULL CHECK(search_model='gpt-6-luna')
);
CREATE TRIGGER seo_model_new_only BEFORE INSERT ON seo_job_models
WHEN EXISTS(SELECT 1 FROM seo_editorial_jobs WHERE id=NEW.job_id) OR EXISTS(SELECT 1 FROM seo_job_models WHERE job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'seo_model_new_only'); END;
CREATE TRIGGER seo_model_no_update BEFORE UPDATE ON seo_job_models BEGIN SELECT RAISE(ABORT,'seo_model_immutable'); END;
CREATE TRIGGER seo_model_no_delete BEFORE DELETE ON seo_job_models BEGIN SELECT RAISE(ABORT,'seo_model_immutable'); END;
CREATE TABLE seo_model_calls (
 call_id TEXT PRIMARY KEY REFERENCES seo_budget_calls(id) DEFERRABLE INITIALLY DEFERRED, job_id TEXT NOT NULL REFERENCES seo_job_models(job_id),
 phase TEXT NOT NULL CHECK(phase IN ('plan','generation','review','discovery','research')),
 model TEXT NOT NULL, request_sha256 TEXT NOT NULL, budget_run_id TEXT NOT NULL
);
CREATE TRIGGER seo_model_call_validate BEFORE INSERT ON seo_model_calls BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM seo_job_models m JOIN seo_editorial_jobs j ON j.id=m.job_id
 JOIN seo_editorial_runs r ON r.run_id=j.run_id
 WHERE m.job_id=NEW.job_id AND r.budget_run_id=NEW.budget_run_id
 AND NOT EXISTS(SELECT 1 FROM seo_budget_calls WHERE id=NEW.call_id)
 AND ((NEW.phase='generation' AND j.call_id=NEW.call_id) OR EXISTS(SELECT 1 FROM seo_all_checks c WHERE c.job_id=j.id AND c.call_id=NEW.call_id AND c.phase=NEW.phase))
 AND NEW.model=CASE WHEN NEW.phase IN ('discovery','research') THEN m.search_model ELSE m.text_model END)
 OR EXISTS(SELECT 1 FROM seo_model_calls WHERE call_id=NEW.call_id)
 THEN RAISE(ABORT,'seo_model_call_identity') END;
END;
CREATE TRIGGER seo_model_call_no_update BEFORE UPDATE ON seo_model_calls BEGIN SELECT RAISE(ABORT,'seo_model_immutable'); END;
CREATE TRIGGER seo_model_call_no_delete BEFORE DELETE ON seo_model_calls BEGIN SELECT RAISE(ABORT,'seo_model_immutable'); END;

CREATE TRIGGER seo_model_job_identity BEFORE UPDATE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_job_models WHERE job_id=OLD.id) AND (NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id)
BEGIN SELECT RAISE(ABORT,'seo_model_immutable'); END;
CREATE TRIGGER seo_model_job_delete BEFORE DELETE ON seo_editorial_jobs WHEN EXISTS(SELECT 1 FROM seo_job_models WHERE job_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'seo_model_immutable'); END;
CREATE TRIGGER seo_model_job_replace BEFORE INSERT ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_job_models m JOIN seo_editorial_jobs j ON j.id=m.job_id WHERE j.id=NEW.id)
BEGIN SELECT RAISE(ABORT,'seo_model_immutable'); END;
CREATE TRIGGER seo_model_charge_update BEFORE UPDATE ON seo_budget_calls
WHEN EXISTS(SELECT 1 FROM seo_model_calls WHERE call_id=OLD.id)
AND (NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.reserved_micros IS NOT OLD.reserved_micros OR NEW.created_at IS NOT OLD.created_at OR NEW.month_jst IS NOT OLD.month_jst)
BEGIN SELECT RAISE(ABORT,'seo_model_immutable'); END;
CREATE TRIGGER seo_model_charge_delete BEFORE DELETE ON seo_budget_calls WHEN EXISTS(SELECT 1 FROM seo_model_calls WHERE call_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'seo_model_immutable'); END;
CREATE TRIGGER seo_model_charge_replace BEFORE INSERT ON seo_budget_calls WHEN EXISTS(SELECT 1 FROM seo_model_calls c JOIN seo_budget_calls b ON b.id=c.call_id WHERE c.call_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'seo_model_immutable'); END;


-- Every reservation for a model-pinned run requires its audit in the same
-- transaction; callers cannot bypass the new contract through the legacy RPC.
CREATE TRIGGER seo_model_reservation BEFORE INSERT ON seo_budget_calls
WHEN EXISTS(SELECT 1 FROM seo_editorial_runs r JOIN seo_editorial_jobs j ON j.run_id=r.run_id JOIN seo_job_models m ON m.job_id=j.id WHERE r.budget_run_id=NEW.run_id) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM seo_model_calls c WHERE c.call_id=NEW.id AND c.budget_run_id=NEW.run_id AND c.request_sha256=NEW.request_sha256)
 THEN RAISE(ABORT,'seo_model_audit_required') END;
 SELECT CASE WHEN NEW.month_jst='2026-10' AND NEW.created_at<1792972800000
 AND NEW.reserved_micros+COALESCE((SELECT SUM(reserved_micros) FROM seo_budget_calls WHERE month_jst='2026-10'),0)>10640000
 THEN RAISE(ABORT,'seo_october_slot_reserved') END;
END;
