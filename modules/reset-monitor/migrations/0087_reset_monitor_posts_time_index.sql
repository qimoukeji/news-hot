CREATE INDEX CONCURRENTLY IF NOT EXISTS monitor_posts_monitor_time_idx ON monitor_posts (monitor_id, published_at DESC);
