-- User approval 2026-10-24: October 2026 JST only $12.48 (+$0.38).
-- Keep October 26 $1.25 reserve, other months $7, and all historical rows.
-- Apply before merging code because Git push triggers the production build.
DROP TRIGGER seo_budget_cap;
CREATE TRIGGER seo_budget_cap BEFORE INSERT ON seo_budget_calls
WHEN NOT EXISTS(SELECT 1 FROM seo_budget_calls WHERE id=NEW.id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM seo_budget_runs WHERE id=NEW.run_id)
  THEN RAISE(ABORT,'seo_budget_run_missing') END;
 SELECT CASE WHEN NEW.reserved_micros + COALESCE((SELECT SUM(reserved_micros) FROM seo_budget_calls WHERE run_id=NEW.run_id),0) > (SELECT run_limit_micros FROM seo_budget_runs WHERE id=NEW.run_id)
  THEN RAISE(ABORT,'seo_run_budget_exhausted') END;
 SELECT CASE WHEN NEW.reserved_micros + COALESCE((SELECT SUM(reserved_micros) FROM seo_budget_calls WHERE month_jst=NEW.month_jst),0) > CASE WHEN NEW.month_jst = '2026-10' THEN 12480000 ELSE 7000000 END
  THEN RAISE(ABORT,'seo_month_budget_exhausted') END;
END;

DROP TRIGGER seo_fallback_first_call_fit;
CREATE TRIGGER seo_fallback_first_call_fit BEFORE INSERT ON seo_budget_calls
WHEN EXISTS(SELECT 1 FROM seo_fallback_attempts WHERE budget_run_id=NEW.run_id)
 AND NOT EXISTS(SELECT 1 FROM seo_budget_calls WHERE run_id=NEW.run_id) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM seo_fallback_attempts a JOIN seo_editorial_runs r ON r.run_id=a.run_id
 JOIN seo_fallback_preflights p ON p.job_id=r.job_id
 WHERE a.budget_run_id=NEW.run_id AND p.maximum_micros+COALESCE((SELECT SUM(b.reserved_micros) FROM seo_budget_calls b
 JOIN seo_fallback_attempts x ON x.budget_run_id=b.run_id WHERE x.root_run_id=a.root_run_id),0)<=1250000
 AND p.maximum_micros+COALESCE((SELECT SUM(reserved_micros) FROM seo_budget_calls WHERE month_jst=NEW.month_jst),0)
 <=CASE WHEN NEW.month_jst='2026-10' THEN 12480000 ELSE 7000000 END)
 THEN RAISE(ABORT,'seo_fallback_preflight_changed') END;
END;

DROP TRIGGER seo_model_reservation;
CREATE TRIGGER seo_model_reservation BEFORE INSERT ON seo_budget_calls
WHEN EXISTS(SELECT 1 FROM seo_editorial_runs r JOIN seo_editorial_jobs j ON j.run_id=r.run_id JOIN seo_job_models m ON m.job_id=j.id WHERE r.budget_run_id=NEW.run_id) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM seo_model_calls c WHERE c.call_id=NEW.id AND c.budget_run_id=NEW.run_id AND c.request_sha256=NEW.request_sha256)
 THEN RAISE(ABORT,'seo_model_audit_required') END;
 SELECT CASE WHEN NEW.month_jst='2026-10' AND NEW.created_at<1792972800000
 AND NEW.reserved_micros+COALESCE((SELECT SUM(reserved_micros) FROM seo_budget_calls WHERE month_jst='2026-10'),0)>11230000
 THEN RAISE(ABORT,'seo_october_slot_reserved') END;
END;
