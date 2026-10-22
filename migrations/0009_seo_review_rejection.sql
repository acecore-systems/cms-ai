-- Dedicated review rejection. Existing research/administrative paths are unchanged.
CREATE TABLE seo_review_rejections (
 job_id TEXT PRIMARY KEY REFERENCES seo_editorial_jobs(id),
 run_id TEXT NOT NULL UNIQUE REFERENCES seo_editorial_runs(run_id),
 receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256)=64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 created_at INTEGER NOT NULL
);
CREATE TRIGGER seo_review_rejection_validate BEFORE INSERT ON seo_review_rejections BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM seo_editorial_jobs j JOIN seo_editorial_runs r ON r.run_id=j.run_id
  WHERE j.id=NEW.job_id AND r.run_id=NEW.run_id AND r.job_id=j.id
   AND j.research_contract=2 AND j.protocol_version=2 AND j.status='generated' AND r.status='pending'
   AND j.next_step=9 AND j.call_id IS NOT NULL AND j.generation_started=1 AND json_array_length(j.paths_json)=9 AND j.publication_started=0
   AND j.claim_recorded=1 AND j.callback_recorded=0 AND r.pr_url IS NULL
   AND NEW.created_at<r.deadline AND NEW.created_at>=r.created_at
   AND json_extract(NEW.receipt_json,'$.runId')=r.run_id
   AND json_extract(NEW.receipt_json,'$.jobId')=j.id
   AND json_extract(NEW.receipt_json,'$.articleKey')=j.article_key
   AND json_extract(NEW.receipt_json,'$.sourceSha256')=j.source_sha256
   AND json_extract(NEW.receipt_json,'$.baseSha')=j.base_sha
   AND json_extract(NEW.receipt_json,'$.githubRunId')=j.github_run_id
   AND json_extract(NEW.receipt_json,'$.deadline')=r.deadline
   AND json_extract(NEW.receipt_json,'$.reason')='confirmed_review_rejection'
   AND json_extract(NEW.receipt_json,'$.publicationStarted')=0
   AND json_extract(NEW.receipt_json,'$.generationCalls')=9 AND json_extract(NEW.receipt_json,'$.generationArtifacts')=9
   AND json_array_length(NEW.receipt_json,'$.calls')=12 AND json_array_length(NEW.receipt_json,'$.files')=9
   AND (SELECT count(*) FROM seo_editorial_checks WHERE job_id=j.id)=3
   AND (SELECT count(*) FROM seo_editorial_checks WHERE job_id=j.id AND phase IN ('plan','research') AND status='complete')=2
   AND (SELECT count(*) FROM seo_editorial_checks WHERE job_id=j.id AND phase='review' AND status='unresolved' AND input_sha256=json_extract(NEW.receipt_json,'$.filesSha256'))=1
   AND (SELECT count(*) FROM seo_budget_calls WHERE run_id=r.budget_run_id)=12
   AND NOT EXISTS(SELECT 1 FROM seo_budget_calls b WHERE b.run_id=r.budget_run_id AND (b.status!='complete' OR NOT EXISTS(SELECT 1 FROM json_each(NEW.receipt_json,'$.calls') c WHERE json_extract(c.value,'$.callId')=b.id)))

 ) THEN RAISE(ABORT,'seo_review_rejection_state') END;
END;
CREATE TRIGGER seo_review_rejection_terminal AFTER INSERT ON seo_review_rejections BEGIN
 UPDATE seo_editorial_jobs SET status='unresolved' WHERE id=NEW.job_id;
 UPDATE seo_editorial_runs SET status='unresolved' WHERE run_id=NEW.run_id;
END;
CREATE TRIGGER seo_review_rejection_no_update BEFORE UPDATE ON seo_review_rejections BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
CREATE TRIGGER seo_review_rejection_no_delete BEFORE DELETE ON seo_review_rejections BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
CREATE TRIGGER seo_review_rejected_job_guard BEFORE UPDATE ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_review_rejections WHERE job_id=OLD.id)
 AND (NEW.status!='unresolved' OR NEW.next_step!=9 OR NEW.call_id IS NOT OLD.call_id OR NEW.generation_started!=1 OR NEW.publication_started!=0 OR NEW.source_sha256 IS NOT OLD.source_sha256 OR NEW.base_sha IS NOT OLD.base_sha OR NEW.article_key IS NOT OLD.article_key OR NEW.run_id!=OLD.run_id OR NEW.github_run_id IS NOT OLD.github_run_id OR NEW.research_contract!=OLD.research_contract OR NEW.paths_json IS NOT OLD.paths_json OR NEW.article_path IS NOT OLD.article_path OR NEW.site_id IS NOT OLD.site_id OR NEW.protocol_version IS NOT OLD.protocol_version OR NEW.claim_recorded IS NOT OLD.claim_recorded OR NEW.callback_recorded<OLD.callback_recorded)
BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
CREATE TRIGGER seo_review_rejected_run_guard BEFORE UPDATE ON seo_editorial_runs
WHEN EXISTS(SELECT 1 FROM seo_review_rejections WHERE run_id=OLD.run_id)
 AND (NEW.status!='unresolved' OR NEW.pr_url IS NOT NULL OR NEW.deadline!=OLD.deadline OR NEW.budget_run_id!=OLD.budget_run_id OR NEW.job_id IS NOT OLD.job_id OR NEW.article_key IS NOT OLD.article_key)
BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;

CREATE TRIGGER seo_review_rejection_no_replace BEFORE INSERT ON seo_review_rejections WHEN EXISTS(SELECT 1 FROM seo_review_rejections WHERE job_id=NEW.job_id OR run_id=NEW.run_id) BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
CREATE TRIGGER seo_review_rejected_job_no_delete BEFORE DELETE ON seo_editorial_jobs WHEN EXISTS(SELECT 1 FROM seo_review_rejections WHERE job_id=OLD.id) BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
CREATE TRIGGER seo_review_rejected_job_no_replace BEFORE INSERT ON seo_editorial_jobs WHEN EXISTS(SELECT 1 FROM seo_review_rejections WHERE job_id=NEW.id) BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
CREATE TRIGGER seo_review_rejected_run_no_delete BEFORE DELETE ON seo_editorial_runs WHEN EXISTS(SELECT 1 FROM seo_review_rejections WHERE run_id=OLD.run_id) BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
CREATE TRIGGER seo_review_rejected_run_no_replace BEFORE INSERT ON seo_editorial_runs WHEN EXISTS(SELECT 1 FROM seo_review_rejections WHERE run_id=NEW.run_id) BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
CREATE TRIGGER seo_review_rejected_budget_no_insert BEFORE INSERT ON seo_budget_calls WHEN EXISTS(SELECT 1 FROM seo_editorial_runs r JOIN seo_review_rejections x ON x.run_id=r.run_id WHERE r.budget_run_id=NEW.run_id) BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
CREATE TRIGGER seo_review_rejected_budget_no_update BEFORE UPDATE ON seo_budget_calls WHEN EXISTS(SELECT 1 FROM seo_editorial_runs r JOIN seo_review_rejections x ON x.run_id=r.run_id WHERE r.budget_run_id=OLD.run_id) BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
CREATE TRIGGER seo_review_rejected_budget_no_delete BEFORE DELETE ON seo_budget_calls WHEN EXISTS(SELECT 1 FROM seo_editorial_runs r JOIN seo_review_rejections x ON x.run_id=r.run_id WHERE r.budget_run_id=OLD.run_id) BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
CREATE TRIGGER seo_review_rejected_check_no_insert BEFORE INSERT ON seo_editorial_checks WHEN EXISTS(SELECT 1 FROM seo_review_rejections WHERE job_id=NEW.job_id) BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
CREATE TRIGGER seo_review_rejected_check_no_update BEFORE UPDATE ON seo_editorial_checks WHEN EXISTS(SELECT 1 FROM seo_review_rejections WHERE job_id=OLD.job_id) BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
CREATE TRIGGER seo_review_rejected_check_no_delete BEFORE DELETE ON seo_editorial_checks WHEN EXISTS(SELECT 1 FROM seo_review_rejections WHERE job_id=OLD.job_id) BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;

CREATE TRIGGER seo_review_rejected_budget_run_no_update BEFORE UPDATE ON seo_budget_runs
WHEN EXISTS(SELECT 1 FROM seo_editorial_runs r JOIN seo_review_rejections x ON x.run_id=r.run_id WHERE r.budget_run_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
CREATE TRIGGER seo_review_rejected_budget_run_no_delete BEFORE DELETE ON seo_budget_runs
WHEN EXISTS(SELECT 1 FROM seo_editorial_runs r JOIN seo_review_rejections x ON x.run_id=r.run_id WHERE r.budget_run_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;

CREATE TRIGGER seo_review_rejected_budget_run_no_replace BEFORE INSERT ON seo_budget_runs
WHEN EXISTS(SELECT 1 FROM seo_editorial_runs r JOIN seo_review_rejections x ON x.run_id=r.run_id WHERE r.budget_run_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
