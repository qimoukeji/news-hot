CREATE INDEX CONCURRENTLY IF NOT EXISTS monitor_webhook_deliveries_subscription_idx ON monitor_webhook_deliveries (subscription_id, created_at DESC);
