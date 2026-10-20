-- Preserve existing calls/results while adding the independently reserved planner phase.
ALTER TABLE seo_editorial_checks RENAME TO seo_editorial_checks_previous;
CREATE TABLE seo_editorial_checks (
 job_id TEXT NOT NULL REFERENCES seo_editorial_jobs(id),
 phase TEXT NOT NULL CHECK(phase IN ('plan','research','review')),
 call_id TEXT NOT NULL UNIQUE,
 input_sha256 TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'started' CHECK(status IN ('started','complete','unresolved')),
 result_sha256 TEXT,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(job_id,phase)
);
INSERT INTO seo_editorial_checks SELECT * FROM seo_editorial_checks_previous;
DROP TABLE seo_editorial_checks_previous;
