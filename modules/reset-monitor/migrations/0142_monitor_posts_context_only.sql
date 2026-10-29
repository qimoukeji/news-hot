ALTER TABLE monitor_source_posts ADD COLUMN IF NOT EXISTS context_only boolean NOT NULL DEFAULT false;
