-- New jobs only. Existing v2 rows and their audit remain untouched.
CREATE TABLE seo_v5_job_models (
 job_id TEXT PRIMARY KEY REFERENCES seo_editorial_jobs(id) DEFERRABLE INITIALLY DEFERRED,
 version INTEGER NOT NULL CHECK(version=5),
 text_model TEXT NOT NULL CHECK(text_model='muse-ember-1.0'),
 search_model TEXT NOT NULL CHECK(search_model='parallel-free')
);
CREATE TRIGGER seo_v5_new_only BEFORE INSERT ON seo_v5_job_models
WHEN EXISTS(SELECT 1 FROM seo_editorial_jobs WHERE id=NEW.job_id) OR EXISTS(SELECT 1 FROM seo_job_models WHERE job_id=NEW.job_id) OR EXISTS(SELECT 1 FROM seo_haiku_job_models WHERE job_id=NEW.job_id) OR EXISTS(SELECT 1 FROM seo_muse_job_models WHERE job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'seo_v5_new_only'); END;
CREATE TRIGGER seo_v2_no_v5 BEFORE INSERT ON seo_job_models WHEN EXISTS(SELECT 1 FROM seo_v5_job_models WHERE job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'seo_model_conflict'); END;
CREATE TRIGGER seo_v5_no_update BEFORE UPDATE ON seo_v5_job_models BEGIN SELECT RAISE(ABORT,'seo_v5_immutable'); END;
CREATE TRIGGER seo_v5_no_delete BEFORE DELETE ON seo_v5_job_models BEGIN SELECT RAISE(ABORT,'seo_v5_immutable'); END;
CREATE TABLE seo_v5_model_calls (
 call_id TEXT PRIMARY KEY REFERENCES seo_budget_calls(id) DEFERRABLE INITIALLY DEFERRED,
 job_id TEXT NOT NULL REFERENCES seo_v5_job_models(job_id),
 phase TEXT NOT NULL CHECK(phase IN ('plan','generation','review','discovery','research')),
 model TEXT NOT NULL, request_sha256 TEXT NOT NULL, budget_run_id TEXT NOT NULL
);
CREATE TRIGGER seo_v5_call_validate BEFORE INSERT ON seo_v5_model_calls BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM seo_v5_job_models m JOIN seo_editorial_jobs j ON j.id=m.job_id
 JOIN seo_editorial_runs r ON r.run_id=j.run_id
 WHERE m.job_id=NEW.job_id AND r.budget_run_id=NEW.budget_run_id
 AND NOT EXISTS(SELECT 1 FROM seo_budget_calls WHERE id=NEW.call_id)
 AND ((NEW.phase='generation' AND j.call_id=NEW.call_id) OR EXISTS(SELECT 1 FROM seo_all_checks c WHERE c.job_id=j.id AND c.call_id=NEW.call_id AND c.phase=NEW.phase))
 AND NEW.model=m.text_model)
 OR EXISTS(SELECT 1 FROM seo_v5_model_calls WHERE call_id=NEW.call_id)
 THEN RAISE(ABORT,'seo_v5_call_identity') END;
END;
CREATE TRIGGER seo_v5_call_no_update BEFORE UPDATE ON seo_v5_model_calls BEGIN SELECT RAISE(ABORT,'seo_v5_immutable'); END;
CREATE TRIGGER seo_v5_call_no_delete BEFORE DELETE ON seo_v5_model_calls BEGIN SELECT RAISE(ABORT,'seo_v5_immutable'); END;
CREATE TRIGGER seo_v5_job_identity BEFORE UPDATE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_v5_job_models WHERE job_id=OLD.id) AND (NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id)
BEGIN SELECT RAISE(ABORT,'seo_v5_immutable'); END;
CREATE TRIGGER seo_v5_job_delete BEFORE DELETE ON seo_editorial_jobs WHEN EXISTS(SELECT 1 FROM seo_v5_job_models WHERE job_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'seo_v5_immutable'); END;
CREATE TRIGGER seo_v5_job_replace BEFORE INSERT ON seo_editorial_jobs WHEN EXISTS(SELECT 1 FROM seo_v5_job_models m JOIN seo_editorial_jobs j ON j.id=m.job_id WHERE j.id=NEW.id)
BEGIN SELECT RAISE(ABORT,'seo_v5_immutable'); END;
CREATE TRIGGER seo_v5_charge_update BEFORE UPDATE ON seo_budget_calls
WHEN EXISTS(SELECT 1 FROM seo_v5_model_calls WHERE call_id=OLD.id)
AND (NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.reserved_micros IS NOT OLD.reserved_micros OR NEW.created_at IS NOT OLD.created_at OR NEW.month_jst IS NOT OLD.month_jst)
BEGIN SELECT RAISE(ABORT,'seo_v5_immutable'); END;
CREATE TRIGGER seo_v5_charge_delete BEFORE DELETE ON seo_budget_calls WHEN EXISTS(SELECT 1 FROM seo_v5_model_calls WHERE call_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'seo_v5_immutable'); END;
CREATE TRIGGER seo_v5_charge_replace BEFORE INSERT ON seo_budget_calls WHEN EXISTS(SELECT 1 FROM seo_v5_model_calls c JOIN seo_budget_calls b ON b.id=c.call_id WHERE c.call_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'seo_v5_immutable'); END;
CREATE TRIGGER seo_v5_reservation BEFORE INSERT ON seo_budget_calls
WHEN EXISTS(SELECT 1 FROM seo_editorial_runs r JOIN seo_editorial_jobs j ON j.run_id=r.run_id JOIN seo_v5_job_models m ON m.job_id=j.id WHERE r.budget_run_id=NEW.run_id) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM seo_v5_model_calls c WHERE c.call_id=NEW.id AND c.budget_run_id=NEW.run_id AND c.request_sha256=NEW.request_sha256)
 THEN RAISE(ABORT,'seo_v5_audit_required') END;
END;
CREATE TRIGGER seo_haiku_no_v5 BEFORE INSERT ON seo_haiku_job_models WHEN EXISTS(SELECT 1 FROM seo_v5_job_models WHERE job_id=NEW.job_id) BEGIN SELECT RAISE(ABORT,'seo_model_conflict'); END;

-- New jobs only: legacy jobs permanently retain the 12,000-token generation request.
CREATE TABLE seo_v5_generation_contracts (
 job_id TEXT PRIMARY KEY NOT NULL REFERENCES seo_editorial_jobs(id) DEFERRABLE INITIALLY DEFERRED,
 version INTEGER NOT NULL CHECK(version=2),
 max_completion_tokens INTEGER NOT NULL CHECK(max_completion_tokens=48000),
 reasoning_effort TEXT NOT NULL CHECK(reasoning_effort='medium')
);
CREATE TRIGGER seo_v5_generation_new_only BEFORE INSERT ON seo_v5_generation_contracts
WHEN EXISTS(SELECT 1 FROM seo_editorial_jobs WHERE id=NEW.job_id) OR EXISTS(SELECT 1 FROM seo_v5_generation_contracts WHERE job_id=NEW.job_id) OR EXISTS(SELECT 1 FROM seo_generation_contracts WHERE job_id=NEW.job_id) OR EXISTS(SELECT 1 FROM seo_muse_generation_contracts WHERE job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'seo_v5_generation_new_only'); END;
CREATE TRIGGER seo_v5_generation_no_update BEFORE UPDATE ON seo_v5_generation_contracts BEGIN SELECT RAISE(ABORT,'seo_v5_generation_immutable'); END;
CREATE TRIGGER seo_v5_generation_no_delete BEFORE DELETE ON seo_v5_generation_contracts BEGIN SELECT RAISE(ABORT,'seo_v5_generation_immutable'); END;
CREATE TRIGGER seo_v5_generation_job_identity BEFORE UPDATE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_v5_generation_contracts WHERE job_id=OLD.id) AND (NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id)
BEGIN SELECT RAISE(ABORT,'seo_v5_generation_immutable'); END;
CREATE TRIGGER seo_v5_generation_job_delete BEFORE DELETE ON seo_editorial_jobs WHEN EXISTS(SELECT 1 FROM seo_v5_generation_contracts WHERE job_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'seo_v5_generation_immutable'); END;
CREATE TRIGGER seo_v5_generation_job_replace BEFORE INSERT ON seo_editorial_jobs WHEN EXISTS(SELECT 1 FROM seo_v5_generation_contracts g JOIN seo_editorial_jobs j ON j.id=g.job_id WHERE j.id=NEW.id)
BEGIN SELECT RAISE(ABORT,'seo_v5_generation_immutable'); END;


CREATE TRIGGER seo_generation_no_v5 BEFORE INSERT ON seo_generation_contracts WHEN EXISTS(SELECT 1 FROM seo_v5_generation_contracts WHERE job_id=NEW.job_id) BEGIN SELECT RAISE(ABORT,'seo_generation_conflict'); END;
CREATE TRIGGER seo_v5_generation_model_required BEFORE INSERT ON seo_editorial_jobs WHEN EXISTS(SELECT 1 FROM seo_v5_generation_contracts WHERE job_id=NEW.id) AND NOT EXISTS(SELECT 1 FROM seo_v5_job_models WHERE job_id=NEW.id AND version=5) BEGIN SELECT RAISE(ABORT,'seo_v5_generation_model_required'); END;

CREATE TRIGGER seo_muse_no_v5 BEFORE INSERT ON seo_muse_job_models WHEN EXISTS(SELECT 1 FROM seo_v5_job_models WHERE job_id=NEW.job_id) BEGIN SELECT RAISE(ABORT,'seo_model_conflict'); END;
CREATE TRIGGER seo_muse_generation_no_v5 BEFORE INSERT ON seo_muse_generation_contracts WHEN EXISTS(SELECT 1 FROM seo_v5_generation_contracts WHERE job_id=NEW.job_id) BEGIN SELECT RAISE(ABORT,'seo_generation_conflict'); END;
CREATE TABLE seo_v5_parallel_searches (
 job_id TEXT PRIMARY KEY REFERENCES seo_v5_job_models(job_id),
 call_id TEXT NOT NULL UNIQUE, request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
 response_sha256 TEXT NOT NULL CHECK(length(response_sha256)=64)
);
CREATE TRIGGER seo_v5_parallel_validate BEFORE INSERT ON seo_v5_parallel_searches BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM seo_discovery_checks c WHERE c.job_id=NEW.job_id AND c.phase='discovery' AND c.call_id=NEW.call_id AND c.status='started') THEN RAISE(ABORT,'seo_v5_search_identity') END;
END;
CREATE TRIGGER seo_v5_parallel_no_update BEFORE UPDATE ON seo_v5_parallel_searches BEGIN SELECT RAISE(ABORT,'seo_v5_immutable'); END;
CREATE TRIGGER seo_v5_parallel_no_delete BEFORE DELETE ON seo_v5_parallel_searches BEGIN SELECT RAISE(ABORT,'seo_v5_immutable'); END;
CREATE TABLE seo_v5_research_proofs (
 job_id TEXT PRIMARY KEY REFERENCES seo_v5_job_models(job_id),
 call_id TEXT NOT NULL UNIQUE, proof_sha256 TEXT NOT NULL CHECK(length(proof_sha256)=64)
);
CREATE TRIGGER seo_v5_research_validate BEFORE INSERT ON seo_v5_research_proofs BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM seo_editorial_checks c WHERE c.job_id=NEW.job_id AND c.phase='research' AND c.call_id=NEW.call_id AND c.status='started') THEN RAISE(ABORT,'seo_v5_research_identity') END;
END;
CREATE TRIGGER seo_v5_research_no_update BEFORE UPDATE ON seo_v5_research_proofs BEGIN SELECT RAISE(ABORT,'seo_v5_immutable'); END;
CREATE TRIGGER seo_v5_research_no_delete BEFORE DELETE ON seo_v5_research_proofs BEGIN SELECT RAISE(ABORT,'seo_v5_immutable'); END;
