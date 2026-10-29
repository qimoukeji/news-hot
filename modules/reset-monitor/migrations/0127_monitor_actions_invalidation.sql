ALTER TABLE monitor_event_actions ADD COLUMN IF NOT EXISTS invalidates_event boolean NOT NULL DEFAULT false;
