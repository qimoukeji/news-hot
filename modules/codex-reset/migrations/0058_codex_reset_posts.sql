CREATE TABLE monitor_posts (
  id             text PRIMARY KEY,
  author         text NOT NULL,
  published_at   timestamptz NOT NULL,
  text           text NOT NULL,
  url            text NOT NULL,
  context        jsonb NOT NULL DEFAULT '[]',
  raw            jsonb,
  translation    text,
  recognition    jsonb,
  receipt_id     bigint,
  origin         text NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'imported')),
  collected_at   timestamptz NOT NULL DEFAULT now(),
  activity       jsonb,
  outage         jsonb,
  processed_at   timestamptz
);
