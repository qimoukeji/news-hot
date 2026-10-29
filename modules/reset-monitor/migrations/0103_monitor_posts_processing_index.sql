CREATE INDEX CONCURRENTLY IF NOT EXISTS monitor_source_posts_processing_idx ON monitor_source_posts (monitor_id,processing_status,published_at,id);
