CREATE TABLE monitor_event_actions (
  monitor_id text NOT NULL,
  id text NOT NULL,
  event_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('announce','confirm','amend','progress','cancel')),
  title jsonb NOT NULL,
  summary jsonb,
  time text,
  result text CHECK (result IN ('announced','available','claim_closed','expired')),
  scope jsonb,
  fact_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (monitor_id,id),
  UNIQUE (monitor_id,event_id,id),
  UNIQUE (monitor_id,event_id,fact_key),
  FOREIGN KEY (monitor_id,event_id) REFERENCES monitor_event_records(monitor_id,id)
);
