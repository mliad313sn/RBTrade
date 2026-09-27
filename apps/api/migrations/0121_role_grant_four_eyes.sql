-- 0121 (IRTC R4-02, R4-10): privileged role grants need four eyes, and approvals need independent approvers.
--
-- - `role_grant` joins the four-eyes kinds. PUT /admin/users/:id/roles opens one whenever a change
--   adds admin, risk_officer, auditor or trader; a second admin approves it.
-- - user_roles records who granted a role, who approved the grant and the request, so an approval
--   by someone whose approver role the requester granted (or approved) can be refused and evidenced.
-- - Nobody grants a role to themselves (NOT VALID: legacy rows keep their history).
ALTER TABLE four_eyes_requests DROP CONSTRAINT four_eyes_requests_kind_check;
ALTER TABLE four_eyes_requests ADD CONSTRAINT four_eyes_requests_kind_check
  CHECK (kind IN ('limit_override', 'kill_switch_resume', 'mfa_reset', 'disclosure_publish', 'role_grant'));

ALTER TABLE user_roles ADD COLUMN approved_by uuid REFERENCES users (id);
ALTER TABLE user_roles ADD COLUMN four_eyes_request_id uuid REFERENCES four_eyes_requests (id);
ALTER TABLE user_roles ADD CONSTRAINT user_roles_no_self_grant
  CHECK (granted_by IS NULL OR granted_by <> user_id) NOT VALID;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_distinct_approver
  CHECK (approved_by IS NULL OR (approved_by <> user_id AND approved_by IS DISTINCT FROM granted_by)) NOT VALID;
