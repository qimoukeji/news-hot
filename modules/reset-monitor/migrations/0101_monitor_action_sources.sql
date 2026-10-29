CREATE TABLE monitor_action_sources (
  monitor_id text NOT NULL,
  event_id text NOT NULL,
  action_id text NOT NULL,
  post_id text NOT NULL,
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  PRIMARY KEY (monitor_id,action_id,post_id),
  FOREIGN KEY (monitor_id,event_id,action_id) REFERENCES monitor_event_actions(monitor_id,event_id,id),
  FOREIGN KEY (monitor_id,event_id,post_id) REFERENCES monitor_event_sources(monitor_id,event_id,post_id)
);
