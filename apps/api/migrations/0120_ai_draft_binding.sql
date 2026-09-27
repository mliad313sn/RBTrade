-- 0120 (IRTC R4-06): an AI order draft is accepted only with the order the server created from it.
--
-- `placed_order_id` is set by the OMS, inside the order's own transaction, when a non-rejected
-- order that matches the draft (symbol, side, qty, type) is submitted with `aiDraftId`. It is set
-- once and never changes; one order binds at most one draft. Accepting the draft requires
-- `order_id = placed_order_id` (checked by the API and by this constraint for every new decision).
ALTER TABLE ai_order_drafts ADD COLUMN placed_order_id uuid REFERENCES orders (id);
CREATE UNIQUE INDEX ai_order_drafts_placed_order_uq ON ai_order_drafts (placed_order_id)
  WHERE placed_order_id IS NOT NULL;
-- NOT VALID: rows decided before this migration keep their history; every new or updated row is checked.
ALTER TABLE ai_order_drafts ADD CONSTRAINT ai_order_drafts_accept_bound
  CHECK (status <> 'accepted' OR (order_id IS NOT NULL AND order_id = placed_order_id)) NOT VALID;

-- The draft guard also allows the one binding update (placed_order_id NULL → an order, still a draft).
CREATE OR REPLACE FUNCTION ai_drafts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bound boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AI drafts are append-only';
  END IF;
  IF TG_TABLE_NAME = 'ai_order_drafts' THEN
    bound := (to_jsonb(OLD) ->> 'placed_order_id') IS NULL AND (to_jsonb(NEW) ->> 'placed_order_id') IS NOT NULL;
    IF (to_jsonb(OLD) ->> 'placed_order_id') IS NOT NULL
       AND (to_jsonb(NEW) ->> 'placed_order_id') IS DISTINCT FROM (to_jsonb(OLD) ->> 'placed_order_id') THEN
      RAISE EXCEPTION 'AI draft % is already bound to an order', OLD.id;
    END IF;
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'AI draft % is already %', OLD.id, OLD.status;
  END IF;
  IF NEW.status = 'draft' AND NOT bound THEN
    RAISE EXCEPTION 'AI draft update must decide it';
  END IF;
  IF to_jsonb(NEW) - ARRAY['status', 'decided_at', 'order_id', 'saved_version_id', 'placed_order_id']
     <> to_jsonb(OLD) - ARRAY['status', 'decided_at', 'order_id', 'saved_version_id', 'placed_order_id'] THEN
    RAISE EXCEPTION 'AI draft content is immutable';
  END IF;
  RETURN NEW;
END $$;
