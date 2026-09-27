-- 0101 (goal 10 observability): W3C trace context of the request that created an order, so the
-- engine's asynchronous fill joins the same trace (ticket → fill). Operational metadata only.
ALTER TABLE orders ADD COLUMN trace_parent text CHECK (trace_parent IS NULL OR trace_parent ~ '^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');
