ALTER TABLE monitor_event_posts ADD CONSTRAINT monitor_event_posts_event_monitor_fkey FOREIGN KEY (monitor_id, event_id) REFERENCES monitor_events (monitor_id, id) ON DELETE CASCADE NOT VALID;
