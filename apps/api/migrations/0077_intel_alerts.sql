-- Goal 07B: Market Radar alerts, evaluated by the server after every scan (never in the browser),
-- and the `radar` surface for AI order drafts ("Draft to ticket" from the radar; the user still
-- previews and confirms in the ticket).

CREATE TABLE intel_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  rule jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX intel_alerts_user_idx ON intel_alerts (user_id, created_at DESC);

CREATE TABLE intel_alert_events (
  id bigserial PRIMARY KEY,
  alert_id uuid NOT NULL REFERENCES intel_alerts (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  symbol text NOT NULL REFERENCES instruments (symbol),
  scan_id bigint REFERENCES intel_scans (id) ON DELETE SET NULL,
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (alert_id, symbol, scan_id)
);
CREATE INDEX intel_alert_events_user_idx ON intel_alert_events (user_id, created_at DESC);

ALTER TABLE ai_order_drafts DROP CONSTRAINT ai_order_drafts_surface_check;
ALTER TABLE ai_order_drafts ADD CONSTRAINT ai_order_drafts_surface_check
  CHECK (surface IN ('chat', 'strip', 'why', 'robots', 'explain', 'eval', 'radar'));

GRANT SELECT, INSERT, UPDATE, DELETE ON intel_alerts TO kora_app;
GRANT SELECT, INSERT ON intel_alert_events TO kora_app;
GRANT USAGE, SELECT ON SEQUENCE intel_alert_events_id_seq TO kora_app;
GRANT SELECT ON intel_alerts, intel_alert_events TO kora_audit_reader;
