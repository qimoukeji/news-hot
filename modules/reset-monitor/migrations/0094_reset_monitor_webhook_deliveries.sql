CREATE TABLE monitor_webhook_deliveries (
  id uuid PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES monitor_webhook_subscriptions(id),
  notification_id uuid NOT NULL REFERENCES monitor_webhook_notifications(id),
  generation integer NOT NULL CHECK (generation > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz DEFAULT now(),
  last_status integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (subscription_id, notification_id)
);
