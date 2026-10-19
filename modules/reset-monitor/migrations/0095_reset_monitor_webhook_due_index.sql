CREATE INDEX CONCURRENTLY IF NOT EXISTS monitor_webhook_deliveries_due_idx ON monitor_webhook_deliveries (next_attempt_at) WHERE status IN ('pending','sending');
