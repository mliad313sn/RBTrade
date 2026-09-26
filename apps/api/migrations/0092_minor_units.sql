-- 0092 minor-unit quotes (B-202, goal 09): instruments quoted in a currency's minor unit (GBX pence,
-- ZAc cents) carry the unit and its factor to the quote currency. Prices and ticks are in the unit;
-- notional, P&L and fees stay in the quote currency (priceMultiplier × factor). SIMULATED registry.
ALTER TABLE instruments
  ADD COLUMN price_unit text CHECK (price_unit IS NULL OR price_unit ~ '^[A-Za-z]{2,4}$'),
  ADD COLUMN price_unit_factor numeric CHECK (price_unit_factor IS NULL OR (price_unit_factor > 0 AND price_unit_factor < 1)),
  ADD CONSTRAINT instruments_price_unit_pair CHECK ((price_unit IS NULL) = (price_unit_factor IS NULL));

-- London equities quote in pence. The SIMULATED tick moves from 0.001 GBP to 0.1 GBX (same size ×100).
UPDATE instruments SET price_unit = 'GBX', price_unit_factor = 0.01, tick_size = 0.1, price_precision = 1
WHERE symbol = 'HSBA.XLON';

-- Existing SIMULATED history for HSBA.XLON was in pounds; rescale it to pence so charts stay continuous.
UPDATE md_candles_history SET open = open * 100, high = high * 100, low = low * 100, close = close * 100 WHERE symbol = 'HSBA.XLON';
UPDATE md_candles SET open = open * 100, high = high * 100, low = low * 100, close = close * 100 WHERE symbol = 'HSBA.XLON';
DELETE FROM md_bars_1s WHERE symbol = 'HSBA.XLON';
DELETE FROM md_trades WHERE symbol = 'HSBA.XLON';
