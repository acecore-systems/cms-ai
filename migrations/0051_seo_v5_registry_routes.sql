CREATE TABLE seo_v5_registry_routes (
 run_id TEXT PRIMARY KEY NOT NULL REFERENCES seo_editorial_runs(run_id),
 policy_revision TEXT NOT NULL CHECK(length(policy_revision) BETWEEN 12 AND 32),
 text_model TEXT NOT NULL CHECK(text_model='muse-ember-1.0')
);
CREATE TRIGGER seo_v5_registry_route_new_only BEFORE INSERT ON seo_v5_registry_routes
WHEN EXISTS(SELECT 1 FROM seo_v5_registry_routes WHERE run_id=NEW.run_id)
 OR NOT EXISTS(SELECT 1 FROM seo_editorial_runs WHERE run_id=NEW.run_id AND status='pending' AND job_id IS NULL AND candidate_index=0)
 OR EXISTS(SELECT 1 FROM seo_editorial_jobs WHERE run_id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'seo_v5_registry_route_new_only'); END;
CREATE TRIGGER seo_v5_registry_route_no_update BEFORE UPDATE ON seo_v5_registry_routes
BEGIN SELECT RAISE(ABORT,'seo_v5_registry_route_immutable'); END;
CREATE TRIGGER seo_v5_registry_route_no_delete BEFORE DELETE ON seo_v5_registry_routes
BEGIN SELECT RAISE(ABORT,'seo_v5_registry_route_immutable'); END;
CREATE TRIGGER seo_v5_registry_job_route BEFORE INSERT ON seo_editorial_jobs
WHEN EXISTS(SELECT 1 FROM seo_v5_registry_routes WHERE run_id=NEW.run_id)
 AND NOT EXISTS(
  SELECT 1 FROM seo_v5_registry_routes r JOIN seo_v5_job_models m ON m.job_id=NEW.id
  WHERE r.run_id=NEW.run_id AND m.text_model=r.text_model
 )
BEGIN SELECT RAISE(ABORT,'seo_v5_registry_job_route'); END;
