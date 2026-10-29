ALTER TABLE monitor_event_actions ADD COLUMN IF NOT EXISTS sequence integer NOT NULL DEFAULT 0;
