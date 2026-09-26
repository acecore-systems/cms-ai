-- SQLite cannot alter a CHECK constraint in place. Preserve existing jobs while
-- allowing GPT-6 Luna's max effort on newly created jobs.
CREATE TABLE cms_ai_jobs_new (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL CHECK (turn_number BETWEEN 1 AND 30),
  requested_by TEXT NOT NULL,
  requested_role TEXT NOT NULL CHECK (requested_role IN ('chat', 'editor', 'admin')),
  instruction TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL DEFAULT 'medium'
    CHECK (reasoning_effort IN ('low', 'medium', 'high', 'max')),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'validating', 'responded', 'failed', 'pr_created', 'merged')
  ),
  branch_name TEXT NOT NULL,
  assistant_message TEXT,
  summary TEXT,
  clarification TEXT,
  pr_url TEXT,
  changed_paths_json TEXT NOT NULL DEFAULT '[]',
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (conversation_id, turn_number)
);

INSERT INTO cms_ai_jobs_new (
  id, site_id, conversation_id, turn_number, requested_by, requested_role,
  instruction, reasoning_effort, status, branch_name, assistant_message,
  summary, clarification, pr_url, changed_paths_json, error_message,
  created_at, updated_at, attachments_json
)
SELECT
  id, site_id, conversation_id, turn_number, requested_by, requested_role,
  instruction, reasoning_effort, status, branch_name, assistant_message,
  summary, clarification, pr_url, changed_paths_json, error_message,
  created_at, updated_at, attachments_json
FROM cms_ai_jobs;

DROP TABLE cms_ai_jobs;
ALTER TABLE cms_ai_jobs_new RENAME TO cms_ai_jobs;

CREATE INDEX idx_cms_ai_jobs_requester_site_created
  ON cms_ai_jobs (requested_by, site_id, created_at DESC);
CREATE INDEX idx_cms_ai_jobs_conversation
  ON cms_ai_jobs (conversation_id, turn_number ASC);
CREATE INDEX idx_cms_ai_jobs_status_updated
  ON cms_ai_jobs (status, updated_at DESC);
