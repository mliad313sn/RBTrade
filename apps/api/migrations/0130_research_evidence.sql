-- 0130 (IRTC R3-02): promotion evidence and trial identity.
--
-- * strategy_trials.config_hash is now the hash of the configuration *and* its data context
--   (symbols, data window by UTC day, split or walk-forward design, cost override). Re-running the
--   same parameters with another split, window, symbol set or spread is a new trial, so the deflated
--   Sharpe deflates it. `context` records what was hashed. Rows written before 0130 keep their
--   parameter-only hash and a NULL context (they still count as trials).
-- * backtest_runs.gate_eligible marks the only runs the promotion checklist may read: a standard
--   backtest of the version's own parameters on its own universe, all available history, the default
--   out-of-sample holdout and the registry costs (no override). `evidence` stores the reasons a run
--   is not eligible. Adding columns with constant defaults does not fire the immutability triggers.
ALTER TABLE strategy_trials ADD COLUMN context jsonb;

ALTER TABLE backtest_runs ADD COLUMN gate_eligible boolean NOT NULL DEFAULT false;
ALTER TABLE backtest_runs ADD COLUMN evidence jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX backtest_runs_evidence_idx ON backtest_runs (version_id, created_at DESC)
  WHERE gate_eligible AND kind = 'backtest';
