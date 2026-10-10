CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS monitor_event_posts_monitor_key_idx ON monitor_event_posts (monitor_id, event_id, post_id);
