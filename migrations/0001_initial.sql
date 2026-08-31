PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cms_ai_memberships (
  site_id TEXT NOT NULL,
  principal_email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('chat', 'editor', 'admin')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, principal_email)
);

CREATE INDEX IF NOT EXISTS idx_cms_ai_memberships_principal
  ON cms_ai_memberships (principal_email, enabled, site_id);

CREATE TABLE IF NOT EXISTS cms_ai_jobs (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL CHECK (turn_number BETWEEN 1 AND 30),
  requested_by TEXT NOT NULL,
  requested_role TEXT NOT NULL CHECK (requested_role IN ('chat', 'editor', 'admin')),
  instruction TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL DEFAULT 'medium'
    CHECK (reasoning_effort IN ('low', 'medium', 'high')),
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
  UNIQUE (conversation_id, turn_number)
);

CREATE INDEX IF NOT EXISTS idx_cms_ai_jobs_requester_site_created
  ON cms_ai_jobs (requested_by, site_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cms_ai_jobs_conversation
  ON cms_ai_jobs (conversation_id, turn_number ASC);

CREATE INDEX IF NOT EXISTS idx_cms_ai_jobs_status_updated
  ON cms_ai_jobs (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS cms_ai_permission_audit (
  id TEXT PRIMARY KEY,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('grant', 'change', 'revoke')),
  site_id TEXT NOT NULL,
  principal_email TEXT NOT NULL,
  previous_role TEXT,
  next_role TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cms_ai_permission_audit_created
  ON cms_ai_permission_audit (created_at DESC);
