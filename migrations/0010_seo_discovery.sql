-- Existing jobs keep their retrieval contract and immutable paid results.
ALTER TABLE seo_editorial_jobs ADD COLUMN retrieval_contract INTEGER NOT NULL DEFAULT 1 CHECK(retrieval_contract IN (1,2));
ALTER TABLE seo_editorial_jobs ADD COLUMN input_allocation_sha256 TEXT CHECK(input_allocation_sha256 IS NULL OR (length(input_allocation_sha256)=64 AND input_allocation_sha256 NOT GLOB '*[^a-f0-9]*'));
CREATE TRIGGER seo_input_allocation_immutable BEFORE UPDATE ON seo_editorial_jobs WHEN OLD.input_allocation_sha256 IS NOT NULL AND NEW.input_allocation_sha256 IS NOT OLD.input_allocation_sha256 BEGIN SELECT RAISE(ABORT,'immutable_input_allocation'); END;
CREATE TABLE seo_discovery_checks (
 job_id TEXT PRIMARY KEY REFERENCES seo_editorial_jobs(id),
 phase TEXT NOT NULL CHECK(phase='discovery'),
 call_id TEXT NOT NULL UNIQUE,
 input_sha256 TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'started' CHECK(status IN ('started','complete','unresolved')),
 result_sha256 TEXT,
 created_at INTEGER NOT NULL
);
CREATE TRIGGER seo_discovery_contract BEFORE INSERT ON seo_discovery_checks WHEN NOT EXISTS(SELECT 1 FROM seo_editorial_jobs WHERE id=NEW.job_id AND retrieval_contract=2) BEGIN SELECT RAISE(ABORT,'discovery_contract'); END;
CREATE VIEW seo_all_checks AS SELECT * FROM seo_editorial_checks UNION ALL SELECT * FROM seo_discovery_checks;
CREATE TRIGGER seo_retrieval_contract_immutable BEFORE UPDATE ON seo_editorial_jobs
WHEN NEW.retrieval_contract!=OLD.retrieval_contract BEGIN SELECT RAISE(ABORT,'immutable_retrieval_contract'); END;
CREATE TRIGGER seo_research_rejections_discovery_no_insert BEFORE INSERT ON seo_discovery_checks WHEN EXISTS(SELECT 1 FROM seo_research_rejections WHERE job_id=NEW.job_id) BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
CREATE TRIGGER seo_research_rejections_discovery_no_update BEFORE UPDATE ON seo_discovery_checks WHEN EXISTS(SELECT 1 FROM seo_research_rejections WHERE job_id=OLD.job_id) BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
CREATE TRIGGER seo_research_rejections_discovery_no_delete BEFORE DELETE ON seo_discovery_checks WHEN EXISTS(SELECT 1 FROM seo_research_rejections WHERE job_id=OLD.job_id) BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
CREATE TRIGGER seo_review_rejections_discovery_no_insert BEFORE INSERT ON seo_discovery_checks WHEN EXISTS(SELECT 1 FROM seo_review_rejections WHERE job_id=NEW.job_id) BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
CREATE TRIGGER seo_review_rejections_discovery_no_update BEFORE UPDATE ON seo_discovery_checks WHEN EXISTS(SELECT 1 FROM seo_review_rejections WHERE job_id=OLD.job_id) BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
CREATE TRIGGER seo_review_rejections_discovery_no_delete BEFORE DELETE ON seo_discovery_checks WHEN EXISTS(SELECT 1 FROM seo_review_rejections WHERE job_id=OLD.job_id) BEGIN SELECT RAISE(ABORT,'immutable_rejection'); END;
DROP TRIGGER seo_rejection_validate;
CREATE TRIGGER seo_rejection_validate BEFORE INSERT ON seo_research_rejections BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM seo_editorial_jobs j JOIN seo_editorial_runs r ON r.run_id=j.run_id
  WHERE j.id=NEW.job_id AND r.run_id=NEW.run_id AND r.job_id=j.id
   AND json_extract(NEW.receipt_json,'$.version')=j.retrieval_contract AND (j.retrieval_contract=2 OR NOT EXISTS(SELECT 1 FROM seo_discovery_checks WHERE job_id=j.id)) AND j.research_contract=2 AND j.protocol_version=2 AND j.status='claimed' AND r.status='pending'
   AND j.next_step=0 AND j.call_id IS NULL AND j.generation_started=0 AND j.publication_started=0
   AND j.claim_recorded=1 AND j.callback_recorded=0 AND r.pr_url IS NULL
   AND NEW.created_at<r.deadline AND NEW.created_at>=r.created_at
   AND json_extract(NEW.receipt_json,'$.runId')=r.run_id
   AND json_extract(NEW.receipt_json,'$.jobId')=j.id
   AND json_extract(NEW.receipt_json,'$.articleKey')=j.article_key
   AND json_extract(NEW.receipt_json,'$.sourceSha256')=j.source_sha256
   AND json_extract(NEW.receipt_json,'$.baseSha')=j.base_sha
   AND json_extract(NEW.receipt_json,'$.githubRunId')=j.github_run_id
   AND json_extract(NEW.receipt_json,'$.deadline')=r.deadline
   AND (SELECT count(*) FROM seo_all_checks WHERE job_id=j.id AND phase IN ('plan','discovery','research')) BETWEEN 1 AND (1+j.retrieval_contract)
   AND NOT EXISTS(SELECT 1 FROM seo_all_checks WHERE job_id=j.id AND phase NOT IN ('plan','discovery','research'))
   AND NOT EXISTS(SELECT 1 FROM seo_budget_calls b WHERE b.run_id=r.budget_run_id AND (b.status!='complete' OR NOT EXISTS(SELECT 1 FROM seo_all_checks c WHERE c.job_id=j.id AND c.call_id=b.id)))
   AND (SELECT count(*) FROM seo_budget_calls WHERE run_id=r.budget_run_id)=(SELECT count(*) FROM seo_all_checks WHERE job_id=j.id)
 ) THEN RAISE(ABORT,'seo_rejection_state') END;
END;
DROP TRIGGER seo_review_rejection_validate;
CREATE TRIGGER seo_review_rejection_validate BEFORE INSERT ON seo_review_rejections BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM seo_editorial_jobs j JOIN seo_editorial_runs r ON r.run_id=j.run_id
  WHERE j.id=NEW.job_id AND r.run_id=NEW.run_id AND r.job_id=j.id
   AND json_extract(NEW.receipt_json,'$.version')=j.retrieval_contract AND (j.retrieval_contract=2 OR NOT EXISTS(SELECT 1 FROM seo_discovery_checks WHERE job_id=j.id)) AND j.research_contract=2 AND j.protocol_version=2 AND j.status='generated' AND r.status='pending'
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
   AND json_array_length(NEW.receipt_json,'$.calls')=(11+j.retrieval_contract) AND json_array_length(NEW.receipt_json,'$.files')=9
   AND (SELECT count(*) FROM seo_all_checks WHERE job_id=j.id)=(2+j.retrieval_contract)
   AND (SELECT count(*) FROM seo_all_checks WHERE job_id=j.id AND phase IN ('plan','discovery','research') AND status='complete')=(1+j.retrieval_contract)
   AND (SELECT count(*) FROM seo_all_checks WHERE job_id=j.id AND phase='review' AND status='unresolved' AND input_sha256=json_extract(NEW.receipt_json,'$.filesSha256'))=1
   AND (SELECT count(*) FROM seo_budget_calls WHERE run_id=r.budget_run_id)=(11+j.retrieval_contract)
   AND NOT EXISTS(SELECT 1 FROM seo_budget_calls b WHERE b.run_id=r.budget_run_id AND (b.status!='complete' OR NOT EXISTS(SELECT 1 FROM json_each(NEW.receipt_json,'$.calls') c WHERE json_extract(c.value,'$.callId')=b.id)))

 ) THEN RAISE(ABORT,'seo_review_rejection_state') END;
END;
