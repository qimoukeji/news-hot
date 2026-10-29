ALTER TABLE monitor_event_actions ADD CONSTRAINT monitor_actions_sources_check CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) > 0) NOT VALID;
