ALTER TABLE monitor_event_actions ADD CONSTRAINT monitor_actions_sequence_check CHECK (sequence > 0) NOT VALID;
