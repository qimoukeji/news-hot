ALTER TABLE monitor_source_posts ADD CONSTRAINT monitor_source_posts_processing_status_check CHECK (processing_status IN ('pending','processed','needs_attention','failed')) NOT VALID;
