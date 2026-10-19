-- External coordinator IDs are permanently mapped to a distinct budget run.
CREATE TABLE seo_editorial_runs (
  run_id TEXT PRIMARY KEY,
  budget_run_id TEXT NOT NULL UNIQUE,
  input_sha256 TEXT NOT NULL,
  deadline INTEGER NOT NULL,
  candidates_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','draft_pr','no_eligible_article','unresolved')),
  candidate_index INTEGER NOT NULL DEFAULT 0,
  job_id TEXT,
  article_key TEXT,
  pr_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE seo_editorial_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES seo_editorial_runs(run_id),
  site_id TEXT NOT NULL,
  candidate_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','inspecting','claiming','claimed','generating','generated','publishing','draft_pr','ineligible','unresolved')),
  github_run_id TEXT,
  source_sha256 TEXT,
  base_sha TEXT,
  article_key TEXT,
  article_path TEXT,
  paths_json TEXT,
  call_id TEXT,
  next_step INTEGER NOT NULL DEFAULT 0,
  claim_recorded INTEGER NOT NULL DEFAULT 0,
  callback_recorded INTEGER NOT NULL DEFAULT 0,
  UNIQUE(run_id,candidate_index)
);
