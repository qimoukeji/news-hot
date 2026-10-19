CREATE TABLE monitor_webhook_subscriptions (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  url text NOT NULL,
  platforms text[] NOT NULL CHECK (cardinality(platforms) BETWEEN 1 AND 3 AND platforms <@ ARRAY['codex','claude-code','grok']::text[]),
  enabled boolean NOT NULL DEFAULT false,
  enabled_at timestamptz,
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
