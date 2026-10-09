CREATE TABLE monitor_events (
  id                   text PRIMARY KEY,
  type                 text NOT NULL CHECK (type IN ('direct_reset', 'reset_credit')),
  status               text NOT NULL CHECK (status IN ('announced', 'confirmed')),
  title                text NOT NULL,
  label                text NOT NULL DEFAULT '',
  display_label        text NOT NULL DEFAULT '',
  scope                text NOT NULL DEFAULT '',
  schedule             jsonb,
  estimate             jsonb,
  presentation         jsonb,
  confirmed_at         timestamptz,
  occurred_on          date,
  confirmation_basis   text CHECK (confirmation_basis IN ('source_post', 'receipt_review')),
  withdrawn            boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL
);
