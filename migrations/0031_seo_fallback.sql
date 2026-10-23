-- Additive protocol 1: no historical rows or triggers are rewritten.
CREATE TABLE seo_fallback_trials (
 root_run_id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version=1),
 created_at INTEGER NOT NULL, deadline INTEGER NOT NULL,
 CHECK(deadline>created_at AND deadline<=created_at+1800000)
);
CREATE TABLE seo_fallback_attempts (
 run_id TEXT PRIMARY KEY, root_run_id TEXT NOT NULL REFERENCES seo_fallback_trials(root_run_id),
 ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 3),
 budget_run_id TEXT NOT NULL UNIQUE, candidate_key TEXT NOT NULL,
 previous_receipt_sha256 TEXT, created_at INTEGER NOT NULL,
 UNIQUE(root_run_id,ordinal), UNIQUE(root_run_id,candidate_key)
);
CREATE TABLE seo_fallback_preflights (
 job_id TEXT PRIMARY KEY REFERENCES seo_editorial_jobs(id),
 maximum_micros INTEGER NOT NULL CHECK(maximum_micros BETWEEN 1 AND 1250000),
 allocation_json TEXT NOT NULL CHECK(json_valid(allocation_json)),
 created_at INTEGER NOT NULL
);
CREATE TRIGGER seo_fallback_new_trial BEFORE INSERT ON seo_fallback_trials BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM seo_editorial_runs WHERE run_id=NEW.root_run_id)
 OR EXISTS(SELECT 1 FROM seo_fallback_trials WHERE root_run_id=NEW.root_run_id)
 THEN RAISE(ABORT,'seo_fallback_new_only') END;
END;
CREATE TRIGGER seo_fallback_attempt_guard BEFORE INSERT ON seo_fallback_attempts BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM seo_editorial_runs WHERE run_id=NEW.run_id OR budget_run_id=NEW.budget_run_id)
 OR EXISTS(SELECT 1 FROM seo_budget_runs WHERE id=NEW.budget_run_id)
 OR NOT EXISTS(SELECT 1 FROM seo_fallback_trials t WHERE t.root_run_id=NEW.root_run_id
 AND NEW.created_at>=t.created_at AND NEW.created_at<t.deadline)
 OR (NEW.ordinal=1 AND (NEW.run_id!=NEW.root_run_id OR NEW.previous_receipt_sha256 IS NOT NULL))
 OR (NEW.ordinal>1 AND NOT EXISTS(
 SELECT 1 FROM seo_fallback_attempts a JOIN seo_research_rejections x ON x.run_id=a.run_id
 JOIN seo_editorial_runs r ON r.run_id=a.run_id JOIN seo_editorial_jobs j ON j.id=x.job_id
 WHERE a.root_run_id=NEW.root_run_id AND a.ordinal=NEW.ordinal-1
 AND x.receipt_sha256=NEW.previous_receipt_sha256 AND j.callback_recorded=1
 AND j.generation_started=0 AND j.publication_started=0 AND j.next_step=0 AND j.call_id IS NULL
 AND r.pr_url IS NULL AND json_extract(x.receipt_json,'$.reason')='confirmed_insufficient'
 AND json_array_length(x.receipt_json,'$.refs')=0 AND json_array_length(x.receipt_json,'$.pullRequests')=0))
 THEN RAISE(ABORT,'seo_fallback_attempt_denied') END;
END;
CREATE TRIGGER seo_fallback_run_insert BEFORE INSERT ON seo_editorial_runs
WHEN EXISTS(SELECT 1 FROM seo_fallback_attempts WHERE run_id=NEW.run_id) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM seo_fallback_attempts a JOIN seo_fallback_trials t USING(root_run_id)
 WHERE a.run_id=NEW.run_id AND a.budget_run_id=NEW.budget_run_id AND NEW.deadline=t.deadline
 AND NEW.created_at=a.created_at AND json_array_length(NEW.candidates_json)=1)
 THEN RAISE(ABORT,'seo_fallback_run_identity') END;
END;
CREATE TRIGGER seo_fallback_run_identity BEFORE UPDATE ON seo_editorial_runs
WHEN EXISTS(SELECT 1 FROM seo_fallback_attempts WHERE run_id=OLD.run_id)
 AND (NEW.run_id IS NOT OLD.run_id OR NEW.budget_run_id IS NOT OLD.budget_run_id OR NEW.deadline IS NOT OLD.deadline
 OR NEW.created_at IS NOT OLD.created_at OR NEW.input_sha256 IS NOT OLD.input_sha256 OR NEW.candidates_json IS NOT OLD.candidates_json)
BEGIN SELECT RAISE(ABORT,'seo_fallback_run_identity'); END;
CREATE TRIGGER seo_fallback_claim BEFORE UPDATE OF article_key ON seo_editorial_jobs
WHEN NEW.article_key IS NOT NULL AND EXISTS(SELECT 1 FROM seo_fallback_attempts WHERE run_id=NEW.run_id)
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM seo_fallback_attempts a JOIN seo_fallback_attempts b USING(root_run_id)
 JOIN seo_editorial_jobs j ON j.run_id=b.run_id
 WHERE a.run_id=NEW.run_id AND j.id!=NEW.id AND j.article_key=NEW.article_key)
 THEN RAISE(ABORT,'seo_fallback_duplicate_article') END;
END;
CREATE TRIGGER seo_fallback_preflight_guard BEFORE INSERT ON seo_fallback_preflights BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM seo_editorial_jobs j JOIN seo_fallback_attempts a ON a.run_id=j.run_id
 JOIN seo_fallback_trials t USING(root_run_id) WHERE j.id=NEW.job_id AND j.status='inspecting'
 AND j.generation_started=0 AND NEW.created_at<t.deadline AND NEW.created_at>=t.created_at
 AND NEW.maximum_micros+COALESCE((SELECT SUM(b.reserved_micros) FROM seo_budget_calls b
 JOIN seo_fallback_attempts x ON x.budget_run_id=b.run_id WHERE x.root_run_id=t.root_run_id),0)<=1250000)
 THEN RAISE(ABORT,'seo_fallback_preflight_denied') END;
END;
CREATE TRIGGER seo_fallback_budget_cap BEFORE INSERT ON seo_budget_calls
WHEN EXISTS(SELECT 1 FROM seo_fallback_attempts WHERE budget_run_id=NEW.run_id) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM seo_fallback_attempts a JOIN seo_fallback_trials t USING(root_run_id)
 JOIN seo_editorial_runs r ON r.run_id=a.run_id JOIN seo_fallback_preflights p ON p.job_id=r.job_id
 WHERE a.budget_run_id=NEW.run_id AND NEW.created_at>=a.created_at AND NEW.created_at<t.deadline
 AND NEW.reserved_micros+COALESCE((SELECT SUM(b.reserved_micros) FROM seo_budget_calls b
 JOIN seo_fallback_attempts x ON x.budget_run_id=b.run_id WHERE x.root_run_id=t.root_run_id),0)<=1250000)
 THEN RAISE(ABORT,'seo_fallback_budget_exhausted') END;
END;
CREATE TRIGGER seo_fallback_budget_identity BEFORE INSERT ON seo_budget_runs
WHEN EXISTS(SELECT 1 FROM seo_fallback_attempts WHERE budget_run_id=NEW.id) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM seo_fallback_attempts a JOIN seo_fallback_trials t USING(root_run_id)
 WHERE a.budget_run_id=NEW.id AND NEW.deadline=t.deadline AND NEW.run_limit_micros=1250000)
 THEN RAISE(ABORT,'seo_fallback_budget_identity') END;
END;
CREATE TRIGGER seo_fallback_one_generation BEFORE UPDATE OF generation_started ON seo_editorial_jobs
WHEN NEW.generation_started=1 AND EXISTS(SELECT 1 FROM seo_fallback_attempts WHERE run_id=NEW.run_id) BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM seo_fallback_attempts a JOIN seo_fallback_attempts b USING(root_run_id)
 JOIN seo_editorial_jobs j ON j.run_id=b.run_id WHERE a.run_id=NEW.run_id AND j.id!=NEW.id AND j.generation_started=1)
 THEN RAISE(ABORT,'seo_fallback_one_generation') END;
END;

CREATE TRIGGER seo_fallback_trials_update BEFORE UPDATE ON seo_fallback_trials BEGIN SELECT RAISE(ABORT,'seo_fallback_immutable'); END;

CREATE TRIGGER seo_fallback_trials_delete BEFORE DELETE ON seo_fallback_trials BEGIN SELECT RAISE(ABORT,'seo_fallback_immutable'); END;

CREATE TRIGGER seo_fallback_trials_insert BEFORE INSERT ON seo_fallback_trials WHEN EXISTS(SELECT 1 FROM seo_fallback_trials WHERE root_run_id=NEW.root_run_id) BEGIN SELECT RAISE(ABORT,'seo_fallback_immutable'); END;

CREATE TRIGGER seo_fallback_attempts_update BEFORE UPDATE ON seo_fallback_attempts BEGIN SELECT RAISE(ABORT,'seo_fallback_immutable'); END;

CREATE TRIGGER seo_fallback_attempts_delete BEFORE DELETE ON seo_fallback_attempts BEGIN SELECT RAISE(ABORT,'seo_fallback_immutable'); END;

CREATE TRIGGER seo_fallback_attempts_insert BEFORE INSERT ON seo_fallback_attempts WHEN EXISTS(SELECT 1 FROM seo_fallback_attempts WHERE run_id=NEW.run_id) BEGIN SELECT RAISE(ABORT,'seo_fallback_immutable'); END;

CREATE TRIGGER seo_fallback_preflights_update BEFORE UPDATE ON seo_fallback_preflights BEGIN SELECT RAISE(ABORT,'seo_fallback_immutable'); END;

CREATE TRIGGER seo_fallback_preflights_delete BEFORE DELETE ON seo_fallback_preflights BEGIN SELECT RAISE(ABORT,'seo_fallback_immutable'); END;

CREATE TRIGGER seo_fallback_preflights_insert BEFORE INSERT ON seo_fallback_preflights WHEN EXISTS(SELECT 1 FROM seo_fallback_preflights WHERE job_id=NEW.job_id) BEGIN SELECT RAISE(ABORT,'seo_fallback_immutable'); END;

CREATE TRIGGER fallback_seo_budget_calls_delete BEFORE DELETE ON seo_budget_calls WHEN EXISTS(SELECT 1 FROM seo_fallback_attempts WHERE budget_run_id=OLD.run_id) BEGIN SELECT RAISE(ABORT,'seo_fallback_immutable'); END;
CREATE TRIGGER fallback_seo_budget_calls_update BEFORE UPDATE ON seo_budget_calls WHEN EXISTS(SELECT 1 FROM seo_fallback_attempts WHERE budget_run_id=OLD.run_id) AND (NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.month_jst IS NOT OLD.month_jst OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.reserved_micros IS NOT OLD.reserved_micros OR NEW.created_at IS NOT OLD.created_at) BEGIN SELECT RAISE(ABORT,'seo_fallback_immutable'); END;

CREATE TRIGGER fallback_seo_budget_runs_delete BEFORE DELETE ON seo_budget_runs WHEN EXISTS(SELECT 1 FROM seo_fallback_attempts WHERE budget_run_id=OLD.id) BEGIN SELECT RAISE(ABORT,'seo_fallback_immutable'); END;
CREATE TRIGGER fallback_seo_budget_runs_update BEFORE UPDATE ON seo_budget_runs WHEN EXISTS(SELECT 1 FROM seo_fallback_attempts WHERE budget_run_id=OLD.id) AND (NEW.id IS NOT OLD.id OR NEW.article_key IS NOT OLD.article_key OR NEW.created_at IS NOT OLD.created_at OR NEW.deadline IS NOT OLD.deadline OR NEW.run_limit_micros IS NOT OLD.run_limit_micros) BEGIN SELECT RAISE(ABORT,'seo_fallback_immutable'); END;

CREATE TRIGGER fallback_seo_editorial_runs_delete BEFORE DELETE ON seo_editorial_runs WHEN EXISTS(SELECT 1 FROM seo_fallback_attempts WHERE run_id=OLD.run_id) BEGIN SELECT RAISE(ABORT,'seo_fallback_immutable'); END;

CREATE TRIGGER seo_fallback_first_call_fit BEFORE INSERT ON seo_budget_calls
WHEN EXISTS(SELECT 1 FROM seo_fallback_attempts WHERE budget_run_id=NEW.run_id)
 AND NOT EXISTS(SELECT 1 FROM seo_budget_calls WHERE run_id=NEW.run_id) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM seo_fallback_attempts a JOIN seo_editorial_runs r ON r.run_id=a.run_id
 JOIN seo_fallback_preflights p ON p.job_id=r.job_id
 WHERE a.budget_run_id=NEW.run_id AND p.maximum_micros+COALESCE((SELECT SUM(b.reserved_micros) FROM seo_budget_calls b
 JOIN seo_fallback_attempts x ON x.budget_run_id=b.run_id WHERE x.root_run_id=a.root_run_id),0)<=1250000
 AND p.maximum_micros+COALESCE((SELECT SUM(reserved_micros) FROM seo_budget_calls WHERE month_jst=NEW.month_jst),0)
 <=CASE WHEN NEW.month_jst='2026-10' THEN 11890000 ELSE 7000000 END)
 THEN RAISE(ABORT,'seo_fallback_preflight_changed') END;
END;
CREATE TRIGGER seo_fallback_charge_replace BEFORE INSERT ON seo_budget_calls
WHEN EXISTS(SELECT 1 FROM seo_budget_calls b JOIN seo_fallback_attempts a ON a.budget_run_id=b.run_id WHERE b.id=NEW.id)
BEGIN SELECT RAISE(ABORT,'seo_fallback_immutable'); END;
