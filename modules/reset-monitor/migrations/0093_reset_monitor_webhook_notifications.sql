CREATE TABLE monitor_webhook_notifications (
  id uuid PRIMARY KEY,
  monitor_id text NOT NULL,
  event_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (monitor_id, event_id, revision)
);
