-- Keep accepted runs in RESEARCHING for compatibility with older workers.
-- Provider queue state is separate so the UI can show it without causing an
-- older worker to treat an accepted response as a new, unsubmitted job.
ALTER TABLE research_jobs ADD COLUMN IF NOT EXISTS provider_status text
  CHECK (provider_status IS NULL OR provider_status IN ('queued', 'in_progress'));
