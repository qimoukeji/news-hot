ALTER TABLE monitor_source_posts ADD COLUMN IF NOT EXISTS filtered_out boolean NOT NULL DEFAULT false;
