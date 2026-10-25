-- One extra review-only job after an entirely unconsumed, expired v1 claim.
-- Existing continuation rows and previous job/run are never rewritten.
CREATE TABLE seo_review_continuation_retries (
 job_id TEXT PRIMARY KEY REFERENCES seo_editorial_jobs(id) DEFERRABLE INITIALLY DEFERRED,
 run_id TEXT NOT NULL UNIQUE REFERENCES seo_editorial_runs(run_id) DEFERRABLE INITIALLY DEFERRED,
 old_job_id TEXT NOT NULL UNIQUE REFERENCES seo_editorial_jobs(id),
 old_run_id TEXT NOT NULL UNIQUE REFERENCES seo_editorial_runs(run_id),
 previous_job_id TEXT NOT NULL UNIQUE REFERENCES seo_editorial_jobs(id),
 previous_run_id TEXT NOT NULL UNIQUE REFERENCES seo_editorial_runs(run_id),
 article_key TEXT NOT NULL UNIQUE,
 manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64),
 manifest_key TEXT NOT NULL UNIQUE,
 files_sha256 TEXT NOT NULL CHECK(length(files_sha256)=64),
 retry_sha256 TEXT NOT NULL CHECK(length(retry_sha256)=64),
 retry_key TEXT NOT NULL UNIQUE,
 version INTEGER NOT NULL CHECK(version=2),
 reasoning_effort TEXT NOT NULL CHECK(reasoning_effort='low'),
 created_at INTEGER NOT NULL
);
CREATE TRIGGER seo_review_retry_new_only BEFORE INSERT ON seo_review_continuation_retries
WHEN NEW.job_id IN(NEW.old_job_id,NEW.previous_job_id) OR NEW.run_id IN(NEW.old_run_id,NEW.previous_run_id)
 OR EXISTS(SELECT 1 FROM seo_editorial_jobs WHERE id=NEW.job_id)
 OR EXISTS(SELECT 1 FROM seo_review_continuation_retries WHERE job_id=NEW.job_id OR previous_job_id=NEW.previous_job_id OR article_key=NEW.article_key)
 OR NOT EXISTS(SELECT 1 FROM seo_review_continuations c JOIN seo_editorial_jobs j ON j.id=c.job_id JOIN seo_editorial_runs r ON r.run_id=c.run_id AND r.job_id=j.id
   JOIN seo_editorial_runs fresh ON fresh.run_id=NEW.run_id AND fresh.job_id=NEW.job_id
   WHERE c.job_id=NEW.previous_job_id AND c.run_id=NEW.previous_run_id AND c.old_job_id=NEW.old_job_id AND c.old_run_id=NEW.old_run_id
   AND c.article_key=NEW.article_key AND c.manifest_sha256=NEW.manifest_sha256 AND c.files_sha256=NEW.files_sha256
   AND j.status='unresolved' AND r.status='unresolved' AND r.deadline<=NEW.created_at AND r.pr_url IS NULL
   AND j.claim_recorded=0 AND j.base_sha IS NULL AND j.call_id IS NULL AND j.generation_started=0 AND j.publication_started=0 AND j.next_step=1
   AND j.callback_recorded=1 AND j.github_run_id IS NOT NULL AND fresh.status='pending' AND fresh.created_at=NEW.created_at
   AND fresh.deadline>NEW.created_at AND fresh.deadline<=NEW.created_at+1800000 AND fresh.article_key=NEW.article_key
   AND NOT EXISTS(SELECT 1 FROM seo_model_calls WHERE job_id=j.id)
   AND NOT EXISTS(SELECT 1 FROM seo_all_checks WHERE job_id=j.id)
   AND NOT EXISTS(SELECT 1 FROM seo_budget_calls WHERE run_id=r.budget_run_id)
   AND NOT EXISTS(SELECT 1 FROM seo_budget_runs WHERE id=r.budget_run_id))
BEGIN SELECT RAISE(ABORT,'seo_review_retry_new_only'); END;
CREATE TRIGGER seo_review_retry_no_update BEFORE UPDATE ON seo_review_continuation_retries BEGIN SELECT RAISE(ABORT,'seo_review_retry_immutable'); END;
CREATE TRIGGER seo_review_retry_no_delete BEFORE DELETE ON seo_review_continuation_retries BEGIN SELECT RAISE(ABORT,'seo_review_retry_immutable'); END;
CREATE TRIGGER seo_review_retry_job_identity BEFORE UPDATE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_review_continuation_retries WHERE job_id=OLD.id) AND
 (NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.site_id IS NOT OLD.site_id OR NEW.candidate_index IS NOT OLD.candidate_index OR (OLD.github_run_id IS NOT NULL AND NEW.github_run_id IS NOT OLD.github_run_id) OR NEW.article_key IS NOT OLD.article_key OR NEW.source_sha256 IS NOT OLD.source_sha256 OR NEW.article_path IS NOT OLD.article_path OR NEW.paths_json IS NOT OLD.paths_json OR NEW.generation_started<>0 OR NEW.next_step<>1 OR NEW.call_id IS NOT NULL OR (OLD.base_sha IS NOT NULL AND NEW.base_sha IS NOT OLD.base_sha))
BEGIN SELECT RAISE(ABORT,'seo_review_retry_immutable'); END;
CREATE TRIGGER seo_review_retry_job_insert BEFORE INSERT ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_review_continuation_retries WHERE job_id=NEW.id) AND
 (NEW.status<>'queued' OR NEW.generation_started<>0 OR NEW.publication_started<>0 OR NEW.next_step<>1 OR NEW.call_id IS NOT NULL OR NEW.claim_recorded<>0
 OR NOT EXISTS(SELECT 1 FROM seo_review_continuation_retries c JOIN seo_editorial_jobs j ON j.id=c.old_job_id JOIN seo_review_effort_contracts e ON e.job_id=c.job_id
   WHERE c.job_id=NEW.id AND c.run_id=NEW.run_id AND c.article_key=NEW.article_key AND e.version=2 AND j.site_id=NEW.site_id
   AND j.source_sha256 IS NEW.source_sha256 AND j.article_path IS NEW.article_path AND j.paths_json IS NEW.paths_json))
BEGIN SELECT RAISE(ABORT,'seo_review_retry_import'); END;
CREATE TRIGGER seo_review_retry_job_delete BEFORE DELETE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_review_continuation_retries WHERE job_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'seo_review_retry_immutable'); END;
CREATE TRIGGER seo_review_retry_job_replace BEFORE INSERT ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_review_continuation_retries p JOIN seo_editorial_jobs j ON j.id=p.job_id WHERE j.id=NEW.id)
BEGIN SELECT RAISE(ABORT,'seo_review_retry_immutable'); END;
CREATE TRIGGER seo_review_retry_review_only BEFORE INSERT ON seo_model_calls
WHEN EXISTS(SELECT 1 FROM seo_review_continuation_retries WHERE job_id=NEW.job_id) AND
 (NEW.phase<>'review' OR EXISTS(SELECT 1 FROM seo_model_calls WHERE job_id=NEW.job_id))
BEGIN SELECT RAISE(ABORT,'seo_review_retry_one_call'); END;
CREATE TRIGGER seo_review_retry_run_identity BEFORE UPDATE ON seo_editorial_runs
WHEN EXISTS(SELECT 1 FROM seo_review_continuation_retries WHERE run_id=OLD.run_id) AND
 (NEW.run_id IS NOT OLD.run_id OR NEW.deadline IS NOT OLD.deadline OR NEW.budget_run_id IS NOT OLD.budget_run_id OR NEW.input_sha256 IS NOT OLD.input_sha256 OR NEW.candidates_json IS NOT OLD.candidates_json OR NEW.job_id IS NOT OLD.job_id OR NEW.article_key IS NOT OLD.article_key)
BEGIN SELECT RAISE(ABORT,'seo_review_retry_immutable'); END;
CREATE TRIGGER seo_review_retry_run_delete BEFORE DELETE ON seo_editorial_runs
WHEN EXISTS(SELECT 1 FROM seo_review_continuation_retries WHERE run_id=OLD.run_id)
BEGIN SELECT RAISE(ABORT,'seo_review_retry_immutable'); END;
CREATE TRIGGER seo_review_retry_run_replace BEFORE INSERT ON seo_editorial_runs
WHEN EXISTS(SELECT 1 FROM seo_review_continuation_retries WHERE run_id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'seo_review_retry_immutable'); END;
CREATE TRIGGER seo_review_retry_previous_seo_editorial_jobs_update BEFORE UPDATE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_review_continuation_retries WHERE previous_job_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'seo_review_retry_previous_immutable'); END;
CREATE TRIGGER seo_review_retry_previous_seo_editorial_jobs_delete BEFORE DELETE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_review_continuation_retries WHERE previous_job_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'seo_review_retry_previous_immutable'); END;
CREATE TRIGGER seo_review_retry_previous_seo_editorial_jobs_insert BEFORE INSERT ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_review_continuation_retries WHERE previous_job_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'seo_review_retry_previous_immutable'); END;
CREATE TRIGGER seo_review_retry_previous_seo_editorial_runs_update BEFORE UPDATE ON seo_editorial_runs
WHEN EXISTS(SELECT 1 FROM seo_review_continuation_retries WHERE previous_run_id=OLD.run_id)
BEGIN SELECT RAISE(ABORT,'seo_review_retry_previous_immutable'); END;
CREATE TRIGGER seo_review_retry_previous_seo_editorial_runs_delete BEFORE DELETE ON seo_editorial_runs
WHEN EXISTS(SELECT 1 FROM seo_review_continuation_retries WHERE previous_run_id=OLD.run_id)
BEGIN SELECT RAISE(ABORT,'seo_review_retry_previous_immutable'); END;
CREATE TRIGGER seo_review_retry_previous_seo_editorial_runs_insert BEFORE INSERT ON seo_editorial_runs
WHEN EXISTS(SELECT 1 FROM seo_review_continuation_retries WHERE previous_run_id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'seo_review_retry_previous_immutable'); END;
CREATE TRIGGER seo_review_retry_previous_call BEFORE INSERT ON seo_model_calls
WHEN EXISTS(SELECT 1 FROM seo_review_continuation_retries WHERE previous_job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'seo_review_retry_previous_immutable'); END;
CREATE TRIGGER seo_review_retry_previous_budget BEFORE INSERT ON seo_budget_runs
WHEN EXISTS(SELECT 1 FROM seo_review_continuation_retries p JOIN seo_editorial_runs r ON r.run_id=p.previous_run_id WHERE r.budget_run_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'seo_review_retry_previous_immutable'); END;

CREATE TRIGGER seo_review_retry_previous_check BEFORE INSERT ON seo_editorial_checks
WHEN EXISTS(SELECT 1 FROM seo_review_continuation_retries WHERE previous_job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'seo_review_retry_previous_immutable'); END;
CREATE TRIGGER seo_review_retry_previous_discovery BEFORE INSERT ON seo_discovery_checks
WHEN EXISTS(SELECT 1 FROM seo_review_continuation_retries WHERE previous_job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'seo_review_retry_previous_immutable'); END;
