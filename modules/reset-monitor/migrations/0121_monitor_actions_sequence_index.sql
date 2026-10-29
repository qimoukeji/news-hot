CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS monitor_actions_sequence_index ON monitor_event_actions (monitor_id,event_id,sequence);
