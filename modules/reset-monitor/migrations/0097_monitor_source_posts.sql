CREATE TABLE monitor_source_posts (
  monitor_id text NOT NULL,
  id text NOT NULL,
  author text NOT NULL,
  published_at timestamptz NOT NULL,
  url text NOT NULL,
  title jsonb,
  summary jsonb,
  source_receipt_id bigint REFERENCES receipts(id),
  model_receipt_id bigint REFERENCES receipts(id),
  processing_status text NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending','accepted','unrelated','needs_review','failed')),
  review_reason text,
  manual boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (monitor_id,id)
);
