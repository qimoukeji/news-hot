CREATE TABLE monitor_event_records (
  monitor_id text NOT NULL,
  id text NOT NULL,
  type text NOT NULL CHECK (type IN ('direct_reset','reset_credit','bonus_credit')),
  title jsonb,
  summary jsonb,
  summary_edited boolean NOT NULL DEFAULT false,
  scope jsonb,
  withdrawn boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (monitor_id,id)
);
