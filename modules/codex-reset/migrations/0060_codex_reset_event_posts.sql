CREATE TABLE monitor_event_posts (
  event_id       text NOT NULL REFERENCES monitor_events (id) ON DELETE CASCADE,
  post_id        text NOT NULL REFERENCES monitor_posts (id) ON DELETE CASCADE,
  stage          text NOT NULL,
  action         text,
  text           text NOT NULL,
  original_text  text NOT NULL,
  PRIMARY KEY (event_id, post_id)
);
