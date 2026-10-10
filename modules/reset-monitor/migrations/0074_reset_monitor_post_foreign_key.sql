ALTER TABLE monitor_event_posts ADD CONSTRAINT monitor_event_posts_post_monitor_fkey FOREIGN KEY (monitor_id, post_id) REFERENCES monitor_posts (monitor_id, id) ON DELETE CASCADE NOT VALID;
