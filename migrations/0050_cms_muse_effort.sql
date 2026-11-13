-- Additive: old workers continue to read the compatible low/high values.
ALTER TABLE cms_ai_jobs ADD COLUMN muse_reasoning_effort TEXT
  CHECK (muse_reasoning_effort IS NULL
    OR (muse_reasoning_effort = 'minimal' AND reasoning_effort = 'low')
    OR (muse_reasoning_effort = 'xhigh' AND reasoning_effort = 'high'));
