import { Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';

/**
 * Subject-access export (goal 09, data protection): everything KORA holds about one person, as JSON.
 * Secrets never leave (password hash, TOTP secret); regulated records are included as they are.
 * Each section is a fixed query on the user's id; the export is audited.
 */
const SECTIONS: Array<{ id: string; sql: string; note?: string }> = [
  {
    id: 'profile',
    sql: `SELECT id, email, display_name, identity_provider, status, failed_logins, locked_until, created_at, updated_at FROM users WHERE id = $1`,
  },
  { id: 'roles', sql: `SELECT role, granted_by, granted_at FROM user_roles WHERE user_id = $1 ORDER BY role` },
  {
    id: 'mfa',
    sql: `SELECT (enabled_at IS NOT NULL) AS enrolled, enabled_at, created_at FROM user_mfa WHERE user_id = $1`,
    note: 'The TOTP secret is encrypted at rest and never exported.',
  },
  { id: 'preferences', sql: `SELECT * FROM user_preferences WHERE user_id = $1` },
  { id: 'accounts', sql: `SELECT * FROM accounts WHERE user_id = $1` },
  { id: 'orders', sql: `SELECT o.* FROM orders o JOIN accounts a ON a.id = o.account_id WHERE a.user_id = $1 ORDER BY o.created_at` },
  { id: 'fills', sql: `SELECT f.* FROM fills f JOIN accounts a ON a.id = f.account_id WHERE a.user_id = $1 ORDER BY f.ts` },
  { id: 'positions', sql: `SELECT p.* FROM positions p JOIN accounts a ON a.id = p.account_id WHERE a.user_id = $1` },
  { id: 'ledger_entries', sql: `SELECT l.* FROM ledger_entries l JOIN accounts a ON a.id = l.account_id WHERE a.user_id = $1 ORDER BY l.created_at` },
  { id: 'disclosure_acknowledgements', sql: `SELECT * FROM disclosure_acknowledgements WHERE user_id = $1 ORDER BY created_at` },
  {
    id: 'questionnaire_attempts',
    sql: `SELECT questionnaire_id, version, score, max_score, score_pct, pass_mark_pct, passed, created_at FROM questionnaire_attempts WHERE user_id = $1 ORDER BY created_at`,
    note: 'Answers are never stored; only scores.',
  },
  { id: 'novice_profile', sql: `SELECT * FROM novice_profiles WHERE user_id = $1` },
  { id: 'strategies', sql: `SELECT id, name, created_at FROM strategies WHERE owner_id = $1 ORDER BY created_at` },
  { id: 'robots', sql: `SELECT id, name, mode, status, allocation, limits, created_at FROM robots WHERE owner_id = $1 ORDER BY created_at` },
  { id: 'ai_order_drafts', sql: `SELECT * FROM ai_order_drafts WHERE user_id = $1 ORDER BY created_at` },
  { id: 'ai_strategy_drafts', sql: `SELECT id, status, created_at FROM ai_strategy_drafts WHERE user_id = $1 ORDER BY created_at` },
  { id: 'price_alerts', sql: `SELECT * FROM price_alerts WHERE user_id = $1` },
  { id: 'intel_alerts', sql: `SELECT * FROM intel_alerts WHERE user_id = $1` },
  { id: 'watchlists', sql: `SELECT * FROM watchlists WHERE user_id = $1` },
  { id: 'layouts', sql: `SELECT name, updated_at FROM user_layouts WHERE user_id = $1` },
  { id: 'sim_scenarios', sql: `SELECT * FROM sim_scenarios WHERE user_id = $1` },
  {
    id: 'four_eyes_requests',
    sql: `SELECT id, kind, subject_type, subject_id, reason, requested_at, status, decided_at FROM four_eyes_requests
          WHERE requested_by = $1 OR subject_id = $1::text OR subject_id IN (SELECT id::text FROM accounts WHERE user_id = $1) ORDER BY requested_at`,
  },
  {
    id: 'audit_events',
    sql: `SELECT e.id::text AS id, e.ts, e.actor_type, e.action, e.entity, e.entity_id, e.payload FROM audit_events e WHERE e.actor_id = $1::text ORDER BY e.id DESC LIMIT 5000`,
    note: 'Your own actions (latest 5,000). The hash-chained log itself stays immutable.',
  },
];

@Injectable()
export class SubjectAccessService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async export(subjectId: string, actorId: string) {
    const exists = await this.db.query('SELECT 1 FROM users WHERE id = $1', [subjectId]);
    if (!exists.length) throw new NotFoundException({ error: 'not_found', message: 'User not found' });
    const data: Record<string, unknown> = {};
    const notes: Record<string, string> = {};
    for (const s of SECTIONS) {
      data[s.id] = await this.db.query(s.sql, [subjectId]);
      if (s.note) notes[s.id] = s.note;
    }
    const mode = subjectId === actorId ? 'self_service' : 'on_behalf';
    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'privacy.subject_access_exported',
      entity: 'user',
      entityId: subjectId,
      payload: { mode, sections: SECTIONS.map((s) => s.id) },
    });
    return {
      generatedAt: new Date().toISOString(),
      subjectId,
      mode,
      environment: 'PAPER',
      notes,
      excluded: ['password hash', 'TOTP secret', 'other users’ data'],
      data,
    };
  }
}
