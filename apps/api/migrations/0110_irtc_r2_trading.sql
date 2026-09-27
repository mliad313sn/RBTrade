-- 0110 (IRTC seat R2 corrections, docs/review/IRTC-R2-fixes.md).
--
-- R2-14: a fill booked while the FX rate to the account currency was stale (e.g. FX closed at the
-- weekend) is flagged, so reports can show which base-currency amounts used the last known rate.
ALTER TABLE fills ADD COLUMN fx_stale boolean NOT NULL DEFAULT false;

-- R2-20: margin close-out orders are placed by the system with their own source.
ALTER TABLE orders DROP CONSTRAINT orders_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_source_check
  CHECK (source ~ '^(manual|ai-draft-accepted|kill-switch|margin-closeout|robot:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
