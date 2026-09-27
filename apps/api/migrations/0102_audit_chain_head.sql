-- 0102 (goal 10 load finding): take the audit chain lock and read the chain head in one round trip.
-- Appends serialise on one advisory lock; at 100 orders/s the lock → head → insert → commit round
-- trips made that lock the platform's bottleneck. A VOLATILE PL/pgSQL function runs each statement
-- with a new snapshot under READ COMMITTED, so the head read after the lock sees every append that
-- committed before the lock was granted (the same guarantee as two separate statements).
CREATE FUNCTION audit_chain_lock_head(OUT head_id bigint, OUT head_hash text, OUT ts text)
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'audit append requires a READ COMMITTED transaction';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('kora.audit_chain'));
  SELECT e.id, e.hash INTO head_id, head_hash FROM audit_events e ORDER BY e.id DESC LIMIT 1;
  ts := to_char(date_trunc('microseconds', clock_timestamp()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
END
$$;

REVOKE ALL ON FUNCTION audit_chain_lock_head() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_chain_lock_head() TO kora_app;
