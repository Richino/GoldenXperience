-- Let a user remove a finished research job (for example one that failed or was
-- cancelled) from their home Plans card. Add-only; the job and its report stay.
ALTER TABLE research_job_watchers ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;
