CREATE TABLE monitor_event_sources (
  monitor_id text NOT NULL,
  event_id text NOT NULL,
  post_id text NOT NULL,
  PRIMARY KEY (monitor_id,event_id,post_id),
  FOREIGN KEY (monitor_id,event_id) REFERENCES monitor_event_records(monitor_id,id),
  FOREIGN KEY (monitor_id,post_id) REFERENCES monitor_source_posts(monitor_id,id)
);
