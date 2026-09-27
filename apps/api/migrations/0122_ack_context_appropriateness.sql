-- 0122 (IRTC R4-09): a new trader acknowledges the risk warning as part of passing the
-- appropriateness assessment; that acknowledgement is recorded with its own context.
ALTER TABLE disclosure_acknowledgements DROP CONSTRAINT disclosure_acknowledgements_context_check;
ALTER TABLE disclosure_acknowledgements ADD CONSTRAINT disclosure_acknowledgements_context_check
  CHECK (context IN ('onboarding', 'banner', 'settings', 'reconfirm', 'appropriateness'));
