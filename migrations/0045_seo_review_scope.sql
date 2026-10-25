-- Scope1 -> scope2 reassessment is bounded by root and policy transition, not incident IDs.
-- Current admission is only a completed-fail v2 continuation; ordinary jobs are not admitted.
CREATE TABLE seo_scope_review_rejections (
 job_id TEXT PRIMARY KEY REFERENCES seo_editorial_jobs(id),
 run_id TEXT NOT NULL UNIQUE REFERENCES seo_editorial_runs(run_id),
 review_scope INTEGER NOT NULL CHECK(review_scope IN(1,2)),
 receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256)=64),
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 created_at INTEGER NOT NULL
);
CREATE TABLE seo_review_scope_reassessments (
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
 rejection_sha256 TEXT NOT NULL CHECK(length(rejection_sha256)=64),
 from_review_scope INTEGER NOT NULL CHECK(from_review_scope=1),
 to_review_scope INTEGER NOT NULL CHECK(to_review_scope=2),
 version INTEGER NOT NULL CHECK(version=3),
 reasoning_effort TEXT NOT NULL CHECK(reasoning_effort='low'),
 created_at INTEGER NOT NULL
);
CREATE TRIGGER seo_scope_reassessment_new_only BEFORE INSERT ON seo_review_scope_reassessments
WHEN NEW.job_id IN(NEW.old_job_id,NEW.previous_job_id) OR NEW.run_id IN(NEW.old_run_id,NEW.previous_run_id)
 OR EXISTS(SELECT 1 FROM seo_editorial_jobs WHERE id=NEW.job_id)
 OR EXISTS(SELECT 1 FROM seo_review_scope_reassessments WHERE job_id=NEW.job_id OR old_job_id=NEW.old_job_id OR article_key=NEW.article_key)
 OR NOT EXISTS(SELECT 1 FROM seo_review_continuation_retries c JOIN seo_editorial_jobs j ON j.id=c.job_id JOIN seo_editorial_runs r ON r.run_id=c.run_id AND r.job_id=j.id
 JOIN seo_scope_review_rejections x ON x.job_id=j.id AND x.run_id=r.run_id AND x.review_scope=1
 JOIN seo_editorial_runs fresh ON fresh.run_id=NEW.run_id AND fresh.job_id=NEW.job_id
 WHERE c.job_id=NEW.previous_job_id AND c.run_id=NEW.previous_run_id AND c.old_job_id=NEW.old_job_id AND c.old_run_id=NEW.old_run_id
 AND c.article_key=NEW.article_key AND c.manifest_sha256=NEW.manifest_sha256 AND c.files_sha256=NEW.files_sha256 AND x.receipt_sha256=NEW.rejection_sha256
 AND j.status='unresolved' AND r.status='unresolved' AND r.deadline<=NEW.created_at AND r.pr_url IS NULL AND j.claim_recorded=1 AND j.callback_recorded=1
 AND j.base_sha IS NOT NULL AND j.github_run_id IS NOT NULL AND j.generation_started=0 AND j.publication_started=0 AND j.next_step=1 AND j.call_id IS NULL
 AND fresh.status='pending' AND fresh.created_at=NEW.created_at AND fresh.article_key=NEW.article_key AND fresh.deadline>NEW.created_at AND fresh.deadline<=NEW.created_at+1800000)
BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_new_only'); END;
CREATE TRIGGER seo_scope_reassessment_no_update BEFORE UPDATE ON seo_review_scope_reassessments BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_immutable'); END;
CREATE TRIGGER seo_scope_reassessment_no_delete BEFORE DELETE ON seo_review_scope_reassessments BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_immutable'); END;
CREATE TRIGGER seo_scope_reassessment_job_identity BEFORE UPDATE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_review_scope_reassessments WHERE job_id=OLD.id) AND
 (NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.site_id IS NOT OLD.site_id OR NEW.candidate_index IS NOT OLD.candidate_index OR (OLD.github_run_id IS NOT NULL AND NEW.github_run_id IS NOT OLD.github_run_id) OR NEW.article_key IS NOT OLD.article_key OR NEW.source_sha256 IS NOT OLD.source_sha256 OR NEW.article_path IS NOT OLD.article_path OR NEW.paths_json IS NOT OLD.paths_json OR NEW.generation_started<>0 OR NEW.next_step<>1 OR NEW.call_id IS NOT NULL OR (OLD.base_sha IS NOT NULL AND NEW.base_sha IS NOT OLD.base_sha))
BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_immutable'); END;
CREATE TRIGGER seo_scope_reassessment_job_insert BEFORE INSERT ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_review_scope_reassessments WHERE job_id=NEW.id) AND
 (NEW.status<>'queued' OR NEW.generation_started<>0 OR NEW.publication_started<>0 OR NEW.next_step<>1 OR NEW.call_id IS NOT NULL OR NEW.claim_recorded<>0
 OR NOT EXISTS(SELECT 1 FROM seo_review_scope_reassessments c JOIN seo_editorial_jobs j ON j.id=c.old_job_id JOIN seo_review_effort_contracts e ON e.job_id=c.job_id
   WHERE c.job_id=NEW.id AND c.run_id=NEW.run_id AND c.article_key=NEW.article_key AND e.version=2 AND j.site_id=NEW.site_id
   AND j.source_sha256 IS NEW.source_sha256 AND j.article_path IS NEW.article_path AND j.paths_json IS NEW.paths_json))
BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_import'); END;
CREATE TRIGGER seo_scope_reassessment_job_delete BEFORE DELETE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_review_scope_reassessments WHERE job_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_immutable'); END;
CREATE TRIGGER seo_scope_reassessment_job_replace BEFORE INSERT ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_review_scope_reassessments p JOIN seo_editorial_jobs j ON j.id=p.job_id WHERE j.id=NEW.id)
BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_immutable'); END;
CREATE TRIGGER seo_scope_reassessment_review_only BEFORE INSERT ON seo_model_calls
WHEN EXISTS(SELECT 1 FROM seo_review_scope_reassessments WHERE job_id=NEW.job_id) AND
 (NEW.phase<>'review' OR EXISTS(SELECT 1 FROM seo_model_calls WHERE job_id=NEW.job_id))
BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_one_call'); END;
CREATE TRIGGER seo_scope_reassessment_run_identity BEFORE UPDATE ON seo_editorial_runs
WHEN EXISTS(SELECT 1 FROM seo_review_scope_reassessments WHERE run_id=OLD.run_id) AND
 (NEW.run_id IS NOT OLD.run_id OR NEW.deadline IS NOT OLD.deadline OR NEW.budget_run_id IS NOT OLD.budget_run_id OR NEW.input_sha256 IS NOT OLD.input_sha256 OR NEW.candidates_json IS NOT OLD.candidates_json OR NEW.job_id IS NOT OLD.job_id OR NEW.article_key IS NOT OLD.article_key)
BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_immutable'); END;
CREATE TRIGGER seo_scope_reassessment_run_delete BEFORE DELETE ON seo_editorial_runs
WHEN EXISTS(SELECT 1 FROM seo_review_scope_reassessments WHERE run_id=OLD.run_id)
BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_immutable'); END;
CREATE TRIGGER seo_scope_reassessment_run_replace BEFORE INSERT ON seo_editorial_runs
WHEN EXISTS(SELECT 1 FROM seo_review_scope_reassessments WHERE run_id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_immutable'); END;
CREATE TRIGGER seo_scope_reassessment_previous_seo_editorial_jobs_update BEFORE UPDATE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_review_scope_reassessments WHERE previous_job_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_previous_immutable'); END;
CREATE TRIGGER seo_scope_reassessment_previous_seo_editorial_jobs_delete BEFORE DELETE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_review_scope_reassessments WHERE previous_job_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_previous_immutable'); END;
CREATE TRIGGER seo_scope_reassessment_previous_seo_editorial_jobs_insert BEFORE INSERT ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_review_scope_reassessments WHERE previous_job_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_previous_immutable'); END;
CREATE TRIGGER seo_scope_reassessment_previous_seo_editorial_runs_update BEFORE UPDATE ON seo_editorial_runs
WHEN EXISTS(SELECT 1 FROM seo_review_scope_reassessments WHERE previous_run_id=OLD.run_id)
BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_previous_immutable'); END;
CREATE TRIGGER seo_scope_reassessment_previous_seo_editorial_runs_delete BEFORE DELETE ON seo_editorial_runs
WHEN EXISTS(SELECT 1 FROM seo_review_scope_reassessments WHERE previous_run_id=OLD.run_id)
BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_previous_immutable'); END;
CREATE TRIGGER seo_scope_reassessment_previous_seo_editorial_runs_insert BEFORE INSERT ON seo_editorial_runs
WHEN EXISTS(SELECT 1 FROM seo_review_scope_reassessments WHERE previous_run_id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_previous_immutable'); END;
CREATE TRIGGER seo_scope_reassessment_previous_call BEFORE INSERT ON seo_model_calls
WHEN EXISTS(SELECT 1 FROM seo_review_scope_reassessments WHERE previous_job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_previous_immutable'); END;
CREATE TRIGGER seo_scope_reassessment_previous_budget BEFORE INSERT ON seo_budget_runs
WHEN EXISTS(SELECT 1 FROM seo_review_scope_reassessments p JOIN seo_editorial_runs r ON r.run_id=p.previous_run_id WHERE r.budget_run_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_previous_immutable'); END;

CREATE TRIGGER seo_scope_reassessment_previous_check BEFORE INSERT ON seo_editorial_checks
WHEN EXISTS(SELECT 1 FROM seo_review_scope_reassessments WHERE previous_job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_previous_immutable'); END;
CREATE TRIGGER seo_scope_reassessment_previous_discovery BEFORE INSERT ON seo_discovery_checks
WHEN EXISTS(SELECT 1 FROM seo_review_scope_reassessments WHERE previous_job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'seo_scope_reassessment_previous_immutable'); END;

CREATE TRIGGER seo_scope_rejection_validate BEFORE INSERT ON seo_scope_review_rejections
WHEN EXISTS(SELECT 1 FROM seo_scope_review_rejections WHERE job_id=NEW.job_id OR run_id=NEW.run_id)
 OR (SELECT count(*) FROM json_each(NEW.receipt_json))<>25
 OR json_extract(NEW.receipt_json,'$.researchContract') IS NOT 2
 OR json_extract(NEW.receipt_json,'$.calls[0].phase') IS NOT 'review' OR json_extract(NEW.receipt_json,'$.calls[0].status') IS NOT 'completed'
 OR (SELECT count(*) FROM json_each(NEW.receipt_json,'$.calls[0]'))<>5 OR (SELECT count(*) FROM json_each(NEW.receipt_json,'$.files[0]'))<>3
 OR json_extract(NEW.receipt_json,'$.version') IS NOT 5 OR json_extract(NEW.receipt_json,'$.reviewScope') IS NOT NEW.review_scope
 OR json_extract(NEW.receipt_json,'$.reason') IS NOT 'confirmed_review_rejection'
 OR json_extract(NEW.receipt_json,'$.generationCalls') IS NOT 0 OR json_extract(NEW.receipt_json,'$.generationArtifacts') IS NOT 0
 OR json_extract(NEW.receipt_json,'$.inheritedGenerationArtifacts') IS NOT 1 OR json_extract(NEW.receipt_json,'$.publicationStarted') IS NOT 0
 OR json_array_length(NEW.receipt_json,'$.calls') IS NOT 1 OR json_array_length(NEW.receipt_json,'$.files') IS NOT 1
 OR json_array_length(NEW.receipt_json,'$.refs') IS NOT 0 OR json_array_length(NEW.receipt_json,'$.pullRequests') IS NOT 0
 OR NOT EXISTS(SELECT 1 FROM seo_editorial_jobs j JOIN seo_editorial_runs r ON r.run_id=j.run_id AND r.job_id=j.id
 WHERE j.id=NEW.job_id AND r.run_id=NEW.run_id AND j.status IN('generated','unresolved') AND r.status IN('pending','unresolved') AND r.pr_url IS NULL
 AND j.claim_recorded=1 AND j.generation_started=0 AND j.publication_started=0 AND j.next_step=1 AND j.call_id IS NULL
 AND json_extract(NEW.receipt_json,'$.jobId')=j.id AND json_extract(NEW.receipt_json,'$.runId')=r.run_id
 AND json_extract(NEW.receipt_json,'$.files[0].path')=j.article_path
 AND json_extract(NEW.receipt_json,'$.articleKey')=j.article_key AND json_extract(NEW.receipt_json,'$.sourceSha256')=j.source_sha256
 AND json_extract(NEW.receipt_json,'$.baseSha')=j.base_sha AND json_extract(NEW.receipt_json,'$.githubRunId')=j.github_run_id
 AND json_extract(NEW.receipt_json,'$.deadline')=r.deadline AND json_extract(NEW.receipt_json,'$.decisionTime')>=r.created_at AND json_extract(NEW.receipt_json,'$.decisionTime')<r.deadline
 AND (SELECT count(*) FROM seo_model_calls WHERE job_id=j.id)=1
 AND (SELECT count(*) FROM seo_all_checks WHERE job_id=j.id)=1
 AND EXISTS(SELECT 1 FROM seo_all_checks k JOIN seo_model_calls m ON m.call_id=k.call_id AND m.job_id=k.job_id JOIN seo_budget_calls b ON b.id=m.call_id AND b.run_id=r.budget_run_id
 WHERE k.job_id=j.id AND k.phase='review' AND m.phase='review' AND k.status='unresolved' AND b.status='complete'
 AND k.input_sha256=json_extract(NEW.receipt_json,'$.filesSha256') AND k.call_id=json_extract(NEW.receipt_json,'$.calls[0].callId'))
 AND (SELECT count(*) FROM seo_budget_calls WHERE run_id=r.budget_run_id)=1
 AND ((NEW.review_scope=1 AND EXISTS(SELECT 1 FROM seo_review_continuation_retries c WHERE c.job_id=j.id AND c.old_job_id=json_extract(NEW.receipt_json,'$.rootJobId') AND c.old_run_id=json_extract(NEW.receipt_json,'$.rootRunId') AND c.manifest_sha256=json_extract(NEW.receipt_json,'$.manifestSha256') AND c.files_sha256=json_extract(NEW.receipt_json,'$.filesSha256')))
 OR (NEW.review_scope=2 AND EXISTS(SELECT 1 FROM seo_review_scope_reassessments c WHERE c.job_id=j.id AND c.old_job_id=json_extract(NEW.receipt_json,'$.rootJobId') AND c.old_run_id=json_extract(NEW.receipt_json,'$.rootRunId') AND c.manifest_sha256=json_extract(NEW.receipt_json,'$.manifestSha256') AND c.files_sha256=json_extract(NEW.receipt_json,'$.filesSha256')))))
BEGIN SELECT RAISE(ABORT,'seo_scope_rejection_evidence'); END;
CREATE TRIGGER seo_scope_rejection_apply AFTER INSERT ON seo_scope_review_rejections WHEN NEW.review_scope=2 BEGIN
 UPDATE seo_editorial_jobs SET status='unresolved' WHERE id=NEW.job_id;
 UPDATE seo_editorial_runs SET status='unresolved' WHERE run_id=NEW.run_id;
END;
CREATE TRIGGER seo_scope_rejection_no_update BEFORE UPDATE ON seo_scope_review_rejections BEGIN SELECT RAISE(ABORT,'seo_scope_rejection_immutable'); END;
CREATE TRIGGER seo_scope_rejection_no_delete BEFORE DELETE ON seo_scope_review_rejections BEGIN SELECT RAISE(ABORT,'seo_scope_rejection_immutable'); END;
CREATE TRIGGER seo_scope_rejected_call BEFORE INSERT ON seo_model_calls WHEN EXISTS(SELECT 1 FROM seo_scope_review_rejections WHERE job_id=NEW.job_id) BEGIN SELECT RAISE(ABORT,'seo_scope_rejection_immutable'); END;
CREATE TRIGGER seo_scope_rejected_job BEFORE UPDATE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_scope_review_rejections WHERE job_id=OLD.id) AND (NEW.status<>'unresolved' OR NEW.publication_started<>0 OR NEW.claim_recorded IS NOT OLD.claim_recorded OR NEW.callback_recorded<OLD.callback_recorded)
BEGIN SELECT RAISE(ABORT,'seo_scope_rejection_immutable'); END;

-- New jobs only. Existing jobs permanently use review scope v1.
CREATE TABLE seo_review_scope_contracts (
 job_id TEXT PRIMARY KEY REFERENCES seo_editorial_jobs(id) DEFERRABLE INITIALLY DEFERRED,
 version INTEGER NOT NULL CHECK(version=2)
);
CREATE TRIGGER seo_review_scope_new_only BEFORE INSERT ON seo_review_scope_contracts
WHEN EXISTS(SELECT 1 FROM seo_editorial_jobs WHERE id=NEW.job_id) OR EXISTS(SELECT 1 FROM seo_review_scope_contracts WHERE job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'seo_review_scope_new_only'); END;
CREATE TRIGGER seo_review_scope_no_update BEFORE UPDATE ON seo_review_scope_contracts BEGIN SELECT RAISE(ABORT,'seo_review_scope_immutable'); END;
CREATE TRIGGER seo_review_scope_no_delete BEFORE DELETE ON seo_review_scope_contracts BEGIN SELECT RAISE(ABORT,'seo_review_scope_immutable'); END;
CREATE TRIGGER seo_review_scope_job_identity BEFORE UPDATE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_review_scope_contracts WHERE job_id=OLD.id) AND (NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id)
BEGIN SELECT RAISE(ABORT,'seo_review_scope_immutable'); END;
CREATE TRIGGER seo_review_scope_job_delete BEFORE DELETE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_review_scope_contracts WHERE job_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'seo_review_scope_immutable'); END;
CREATE TRIGGER seo_review_scope_job_replace BEFORE INSERT ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_review_scope_contracts p JOIN seo_editorial_jobs j ON j.id=p.job_id WHERE j.id=NEW.id)
BEGIN SELECT RAISE(ABORT,'seo_review_scope_immutable'); END;

CREATE TRIGGER seo_scope_rejected_run BEFORE UPDATE ON seo_editorial_runs
WHEN EXISTS(SELECT 1 FROM seo_scope_review_rejections WHERE run_id=OLD.run_id) AND (NEW.status<>'unresolved' OR NEW.pr_url IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'seo_scope_rejection_immutable'); END;
