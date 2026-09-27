-- 0131 (IRTC R3-03): the "edge after costs" test per calibration model, with dependence accounted
-- for. Rows are clustered in time buckets of one horizon (any instrument, same bucket = one
-- observation) and the t-statistic uses a HAC variance over the bucket series. Rebuilt with the bins
-- from ai_predictions; a model with no row here falls back to the pooled test and can never show a
-- positive edge from fewer than 30 buckets once it has one.
CREATE TABLE ai_calibration_edge (
  model_key text PRIMARY KEY CHECK (length(model_key) BETWEEN 3 AND 160),
  method text NOT NULL CHECK (method IN ('time_bucket_hac')),
  n integer NOT NULL CHECK (n >= 0),
  clusters integer NOT NULL CHECK (clusters >= 0),
  bucket_ms bigint NOT NULL CHECK (bucket_ms >= 0),
  lag integer NOT NULL CHECK (lag >= 0),
  mean_net_return double precision,
  t_stat double precision,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_calibration_edge TO kora_app;
GRANT SELECT ON ai_calibration_edge TO kora_audit_reader;
