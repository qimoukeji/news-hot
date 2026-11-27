ALTER TABLE monitor_webhook_subscriptions ADD CONSTRAINT monitor_webhook_subscriptions_nonempty_platforms_check
  CHECK (cardinality(platforms) > 0) NOT VALID;
