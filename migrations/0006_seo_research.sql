-- Existing jobs retain their original protocol. New jobs explicitly select v2.
ALTER TABLE seo_editorial_jobs ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1 CHECK(protocol_version IN (1,2));
CREATE TABLE seo_editorial_checks (
  job_id TEXT NOT NULL REFERENCES seo_editorial_jobs(id),
  phase TEXT NOT NULL CHECK(phase IN ('research','review')),
  call_id TEXT NOT NULL UNIQUE,
  input_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started' CHECK(status IN ('started','complete','unresolved')),
  result_sha256 TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(job_id,phase)
);
