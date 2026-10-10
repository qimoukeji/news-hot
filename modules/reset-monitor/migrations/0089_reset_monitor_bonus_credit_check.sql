ALTER TABLE monitor_events ADD CONSTRAINT monitor_events_event_type_check CHECK (type IN ('direct_reset', 'reset_credit', 'bonus_credit')) NOT VALID;
