ALTER TABLE monitor_webhook_subscriptions ADD CONSTRAINT monitor_webhook_subscriptions_supported_platforms_check
  CHECK (cardinality(platforms) BETWEEN 1 AND 4 AND platforms <@ ARRAY['codex','claude-code','grok','gemini']::text[]) NOT VALID;
