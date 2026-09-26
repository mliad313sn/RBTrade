import type { ChainVerification } from '@kora/domain';

import type { DbService } from '../../db/db.service';
import type { AnchorsService } from '../anchors.service';
import { retentionReport } from '../retention';

export type Cell = string | number | boolean | null;

export interface EvidenceTable {
  columns: string[];
  rows: Cell[][];
  /** Headline figures the test procedure looks at (e.g. violations = 0). */
  summary: Record<string, Cell>;
}

export interface EvidenceContext {
  db: DbService;
  verifyChain: () => Promise<ChainVerification>;
  anchors: AnchorsService;
  liveTradingEnabled: boolean;
  env: NodeJS.ProcessEnv;
}

export interface Range {
  from: Date;
  to: Date;
}

const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : (typeof d === 'string' ? new Date(d) : d).toISOString();

type Row = Record<string, unknown>;

function table(columns: string[], rows: Row[], summary: Record<string, Cell> = {}): EvidenceTable {
  return {
    columns,
    rows: rows.map((r) =>
      columns.map((c) => {
        const v = r[c];
        if (v instanceof Date) return v.toISOString();
        if (v === undefined) return null;
        if (typeof v === 'object' && v !== null) return JSON.stringify(v);
        return v as Cell;
      }),
    ),
    summary: { rows: rows.length, ...summary },
  };
}

const PRIVILEGED = `('trader','quant','risk_officer','admin','auditor')`;
const LIMIT_CODES = `('MAX_ORDER_NOTIONAL','FAT_FINGER','MAX_POSITION','MAX_LEVERAGE','INSUFFICIENT_MARGIN','DAILY_LOSS_LIMIT','WEEKLY_LOSS_LIMIT','MONTHLY_LOSS_LIMIT','ORDER_RATE_LIMIT')`;

/**
 * One implemented evidence query per control (goal 09). Each returns a table for the period
 * [from, to) plus the headline figures its test procedure checks. All queries run as the runtime
 * role (read-only use); identifiers are constants, values are bound parameters.
 */
export const EVIDENCE: Record<string, (ctx: EvidenceContext, r: Range) => Promise<EvidenceTable>> = {
  'KC-01': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT u.id AS user_id, string_agg(DISTINCT ur.role, ' ' ORDER BY ur.role) AS roles,
              (m.enabled_at IS NOT NULL) AS mfa_enabled, m.enabled_at AS mfa_enabled_at,
              (SELECT count(*)::int FROM audit_events a WHERE a.actor_id = u.id::text AND a.action = 'auth.login' AND a.ts >= $1 AND a.ts < $2) AS logins_in_period,
              (SELECT count(*)::int FROM audit_events a WHERE a.actor_id = u.id::text AND a.action = 'auth.mfa_failed' AND a.ts >= $1 AND a.ts < $2) AS mfa_failures_in_period
       FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.role IN ${PRIVILEGED}
       LEFT JOIN user_mfa m ON m.user_id = u.id
       GROUP BY u.id, m.enabled_at ORDER BY u.id`,
      [from, to],
    );
    const without = rows.filter((r) => !r.mfa_enabled);
    return table(['user_id', 'roles', 'mfa_enabled', 'mfa_enabled_at', 'logins_in_period', 'mfa_failures_in_period'], rows, {
      privileged_users: rows.length,
      privileged_without_mfa: without.length,
      privileged_without_mfa_who_signed_in: without.filter((r) => Number(r.logins_in_period) > 0).length,
    });
  },
  'KC-02': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT id::text AS audit_id, ts, actor_id AS changed_by, entity_id AS user_id, payload->'before' AS before, payload->'after' AS after
       FROM audit_events WHERE action = 'admin.roles_changed' AND ts >= $1 AND ts < $2 ORDER BY id`,
      [from, to],
    );
    const roster = await db.query<{ n: string }>(`SELECT count(DISTINCT user_id)::text AS n FROM user_roles WHERE role IN ${PRIVILEGED}`);
    return table(['audit_id', 'ts', 'changed_by', 'user_id', 'before', 'after'], rows, {
      role_changes: rows.length,
      privileged_roster_now: Number(roster[0]?.n ?? 0),
    });
  },
  'KC-03': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT to_char(date_trunc('day', ts) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, payload->>'reason' AS reason, count(*)::int AS failures
       FROM audit_events WHERE action = 'auth.login_failed' AND ts >= $1 AND ts < $2 GROUP BY 1, 2 ORDER BY 1, 2`,
      [from, to],
    );
    const locked = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM users WHERE locked_until > now()`);
    return table(['day', 'reason', 'failures'], rows, {
      failed_sign_ins: rows.reduce((s, r) => s + Number(r.failures), 0),
      locked_now: Number(locked[0]?.n ?? 0),
    });
  },
  'KC-04': async ({ db }) => {
    const rows = await db.query<Row>(
      `SELECT a.user_id, string_agg(o.role, ' ' ORDER BY o.role) AS conflicting_roles
       FROM user_roles a LEFT JOIN user_roles o ON o.user_id = a.user_id AND o.role IN ('trader','quant','risk_officer','admin')
       WHERE a.role = 'auditor' GROUP BY a.user_id ORDER BY a.user_id`,
    );
    return table(['user_id', 'conflicting_roles'], rows, {
      auditors: rows.length,
      conflicts: rows.filter((r) => r.conflicting_roles).length,
    });
  },
  'KC-05': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT 'signoff' AS event, s.id::text AS id, s.robot_id, r.owner_id, s.signed_by AS actor, s.signed_at AS at, s.limits_hash,
              (s.limits_hash = r.limits_hash) AS limits_hash_current, NULL::text AS outcome
       FROM robot_risk_signoffs s JOIN robots r ON r.id = s.robot_id WHERE s.signed_at >= $1 AND s.signed_at < $2
       UNION ALL
       SELECT 'promotion', p.id::text, p.robot_id, r.owner_id, p.requested_by, p.created_at, r.limits_hash, NULL, p.outcome
       FROM robot_promotions p JOIN robots r ON r.id = p.robot_id WHERE p.created_at >= $1 AND p.created_at < $2
       ORDER BY at`,
      [from, to],
    );
    const bad = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM robot_risk_signoffs s JOIN robots r ON r.id = s.robot_id WHERE s.signed_by = r.owner_id`,
    );
    return table(['event', 'id', 'robot_id', 'owner_id', 'actor', 'at', 'limits_hash', 'limits_hash_current', 'outcome'], rows, {
      signoffs: rows.filter((r) => r.event === 'signoff').length,
      promotions: rows.filter((r) => r.event === 'promotion').length,
      signed_by_owner_ever: Number(bad[0]?.n ?? 0),
    });
  },
  'KC-06': async ({ db }, r) => fourEyes(db, r, ['limit_override']),
  'KC-07': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT a.id::text AS audit_id, a.ts, a.entity_id AS account_id, a.actor_id AS resumed_by, acc.user_id::text AS owner_id,
              a.payload->>'haltedBy' AS halted_by, a.payload->>'fourEyesRequestId' AS four_eyes_request,
              a.payload->>'requestedBy' AS requested_by, a.payload->>'approvedBy' AS approved_by,
              (a.payload->>'haltedBy' IS NOT NULL AND a.payload->>'haltedBy' <> acc.user_id::text) AS firm_halt
       FROM audit_events a LEFT JOIN accounts acc ON acc.id::text = a.entity_id
       WHERE a.action = 'kill_switch.resumed' AND a.ts >= $1 AND a.ts < $2 ORDER BY a.id`,
      [from, to],
    );
    const firm = rows.filter((x) => x.firm_halt);
    return table(
      ['audit_id', 'ts', 'account_id', 'owner_id', 'halted_by', 'resumed_by', 'firm_halt', 'four_eyes_request', 'requested_by', 'approved_by'],
      rows,
      {
        resumes: rows.length,
        firm_resumes: firm.length,
        firm_resumes_without_four_eyes: firm.filter((x) => !x.four_eyes_request || x.requested_by === x.approved_by).length,
      },
    );
  },
  'KC-08': async ({ db }, r) => fourEyes(db, r, ['mfa_reset', 'disclosure_publish']),
  'KC-09': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT v.id, v.strategy_id, v.version, v.author_id, v.reason, v.content_hash, v.created_at
       FROM strategy_versions v WHERE v.created_at >= $1 AND v.created_at < $2 ORDER BY v.created_at`,
      [from, to],
    );
    const trig = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_trigger WHERE tgname = 'strategy_versions_immutable' AND tgenabled <> 'D'`,
    );
    return table(['id', 'strategy_id', 'version', 'author_id', 'reason', 'content_hash', 'created_at'], rows, {
      versions: rows.length,
      without_author_or_reason: rows.filter((x) => !x.author_id || !x.reason).length,
      immutability_trigger_enabled: Number(trig[0]?.n ?? 0) === 1,
    });
  },
  'KC-10': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT version, name, sha256, applied_at, (applied_at >= $1 AND applied_at < $2) AS applied_in_period
       FROM schema_migrations ORDER BY version`,
      [from, to],
    );
    return table(['version', 'name', 'sha256', 'applied_at', 'applied_in_period'], rows, {
      migrations: rows.length,
      applied_in_period: rows.filter((x) => x.applied_in_period).length,
    });
  },
  'KC-11': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT id::text AS audit_id, ts, payload->>'environment' AS environment, payload->>'buildSha' AS build_sha,
              payload->>'approvalRef' AS approval_ref, payload->>'version' AS version
       FROM audit_events WHERE action = 'system.release_started' AND ts >= $1 AND ts < $2 ORDER BY id`,
      [from, to],
    );
    const prodLike = rows.filter((x) => x.environment === 'staging' || x.environment === 'production');
    return table(['audit_id', 'ts', 'environment', 'build_sha', 'approval_ref', 'version'], rows, {
      releases: rows.length,
      releases_outside_dev_test: prodLike.length,
      releases_outside_dev_test_without_approval: prodLike.filter((x) => !x.approval_ref).length,
    });
  },
  'KC-12': async ({ db, verifyChain }, { from, to }) => {
    const v = await verifyChain();
    const inPeriod = await db.query<{ n: string; first: string | null; last: string | null }>(
      `SELECT count(*)::text AS n, min(id)::text AS first, max(id)::text AS last FROM audit_events WHERE ts >= $1 AND ts < $2`,
      [from, to],
    );
    const row = {
      verified_at: new Date(),
      valid: v.valid,
      events_verified: v.count,
      first_broken_id: v.firstBrokenId,
      reason: v.reason,
      head_hash: v.headHash,
      events_in_period: Number(inPeriod[0]?.n ?? 0),
      first_id_in_period: inPeriod[0]?.first ?? null,
      last_id_in_period: inPeriod[0]?.last ?? null,
    };
    return table(Object.keys(row), [row], { valid: v.valid, events_verified: v.count, first_broken_id: v.firstBrokenId });
  },
  'KC-13': async ({ anchors }, { from, to }) => {
    const list = await anchors.list(from, to);
    return table(
      ['id', 'anchoredAt', 'headId', 'headHash', 'eventCount', 'keyId', 'createdBy', 'signatureValid', 'matchesChain'],
      list as unknown as Row[],
      {
        anchors: list.length,
        invalid_signatures: list.filter((a) => !a.signatureValid).length,
        not_matching_chain: list.filter((a) => !a.matchesChain).length,
      },
    );
  },
  'KC-14': async ({ db }) => {
    const priv = await db.query<Row>(
      `SELECT 'audit_events' AS object, 'kora_app UPDATE' AS check, has_table_privilege('kora_app', 'audit_events', 'UPDATE') AS value
       UNION ALL SELECT 'audit_events', 'kora_app DELETE', has_table_privilege('kora_app', 'audit_events', 'DELETE')
       UNION ALL SELECT 'audit_events', 'kora_app TRUNCATE', has_table_privilege('kora_app', 'audit_events', 'TRUNCATE')
       UNION ALL SELECT 'fills', 'kora_app DELETE', has_table_privilege('kora_app', 'fills', 'DELETE')
       UNION ALL SELECT 'ledger_entries', 'kora_app DELETE', has_table_privilege('kora_app', 'ledger_entries', 'DELETE')`,
    );
    const expected = [
      'audit_events_no_update_delete',
      'audit_events_no_truncate',
      'ledger_entries_no_update',
      'fills_no_update',
      'disclosure_acknowledgements_immutable',
      'four_eyes_requests_guard',
      'robot_risk_signoffs_four_eyes',
      'strategy_versions_immutable',
      'audit_anchors_immutable',
      'disclosure_documents_guard',
    ];
    const trig = await db.query<{ tgname: string; enabled: boolean }>(
      `SELECT tgname, (tgenabled <> 'D') AS enabled FROM pg_trigger WHERE tgname = ANY($1::text[])`,
      [expected],
    );
    const present = new Map(trig.map((t) => [t.tgname, t.enabled]));
    const rows: Row[] = [
      ...priv,
      ...expected.map((t) => ({ object: t, check: 'trigger enabled', value: present.get(t) ?? false })),
    ];
    return table(['object', 'check', 'value'], rows, {
      runtime_can_modify_audit: priv.slice(0, 3).some((p) => p.value === true),
      triggers_missing_or_disabled: expected.filter((t) => !present.get(t)).length,
    });
  },
  'KC-15': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT reject_code AS code, count(*)::int AS rejections, count(DISTINCT account_id)::int AS accounts,
              (reject_code IN ${LIMIT_CODES}) AS limit_code
       FROM orders WHERE status = 'rejected' AND created_at >= $1 AND created_at < $2 GROUP BY reject_code ORDER BY 2 DESC`,
      [from, to],
    );
    const alerts = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM alerts WHERE kind = 'risk.limit_breach' AND created_at >= $1 AND created_at < $2`,
      [from, to],
    );
    return table(['code', 'rejections', 'accounts', 'limit_code'], rows, {
      rejections: rows.reduce((s, x) => s + Number(x.rejections), 0),
      limit_breach_alerts: Number(alerts[0]?.n ?? 0),
    });
  },
  'KC-16': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT 'rejection' AS event, reject_code AS detail, count(*)::int AS events, count(DISTINCT account_id)::int AS accounts
       FROM orders WHERE status = 'rejected' AND created_at >= $1 AND created_at < $2
         AND (reject_code LIKE 'NOVICE_%' OR reject_code IN ('MONTHLY_LOSS_LIMIT', 'DISCLOSURE_NOT_ACKNOWLEDGED'))
       GROUP BY reject_code
       UNION ALL
       SELECT 'loosening_request', key, count(*)::int, count(DISTINCT entity_id)::int
       FROM audit_events, jsonb_object_keys(payload->'limitsPending') AS key
       WHERE action = 'account.settings_updated' AND (payload->>'guarded')::boolean AND ts >= $1 AND ts < $2
       GROUP BY key ORDER BY 1, 3 DESC`,
      [from, to],
    );
    return table(['event', 'detail', 'events', 'accounts'], rows, {
      guardrail_rejections: rows.filter((x) => x.event === 'rejection').reduce((s, x) => s + Number(x.events), 0),
      guarded_loosening_requests: rows.filter((x) => x.event === 'loosening_request').reduce((s, x) => s + Number(x.events), 0),
    });
  },
  'KC-17': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT id::text AS audit_id, ts, actor_id, payload->>'accountId' AS account_id, payload->>'scope' AS scope,
              (payload->>'durationMs')::int AS duration_ms, (payload->>'ordersCancelled')::int AS orders_cancelled,
              (payload->>'positionsFlattened')::int AS positions_flattened, (payload->>'flattenPending')::int AS flatten_pending,
              COALESCE((payload->>'firm')::boolean, false) AS firm
       FROM audit_events WHERE action = 'kill_switch.completed' AND ts >= $1 AND ts < $2 ORDER BY id`,
      [from, to],
    );
    return table(
      ['audit_id', 'ts', 'actor_id', 'account_id', 'scope', 'firm', 'duration_ms', 'orders_cancelled', 'positions_flattened', 'flatten_pending'],
      rows,
      {
        activations: rows.length,
        max_duration_ms: rows.reduce((m, x) => Math.max(m, Number(x.duration_ms ?? 0)), 0),
        over_2000_ms: rows.filter((x) => Number(x.duration_ms ?? 0) > 2000).length,
      },
    );
  },
  'KC-18': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT id, created_at, severity, kind, account_id, details->>'robotId' AS robot_id, message, acknowledged_at
       FROM alerts WHERE kind LIKE 'robot.%' AND created_at >= $1 AND created_at < $2 ORDER BY created_at`,
      [from, to],
    );
    return table(['id', 'created_at', 'severity', 'kind', 'account_id', 'robot_id', 'message', 'acknowledged_at'], rows, {
      auto_pauses: rows.length,
    });
  },
  'KC-19': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT id, created_at, severity, kind, account_id, acknowledged_at, acknowledged_by,
              CASE WHEN acknowledged_at IS NULL THEN NULL ELSE round(extract(epoch FROM acknowledged_at - created_at))::int END AS seconds_to_ack
       FROM alerts WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at`,
      [from, to],
    );
    return table(['id', 'created_at', 'severity', 'kind', 'account_id', 'acknowledged_at', 'acknowledged_by', 'seconds_to_ack'], rows, {
      alerts: rows.length,
      critical: rows.filter((x) => x.severity === 'critical').length,
      critical_unacknowledged: rows.filter((x) => x.severity === 'critical' && !x.acknowledged_at).length,
    });
  },
  'KC-20': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT id, trigger, requested_by, started_at, finished_at, accounts_checked, mismatches,
              round(extract(epoch FROM started_at - lag(started_at) OVER (ORDER BY started_at)))::int AS seconds_since_previous
       FROM reconciliation_runs WHERE started_at >= $1 AND started_at < $2 ORDER BY started_at`,
      [from, to],
    );
    return table(['id', 'trigger', 'requested_by', 'started_at', 'finished_at', 'accounts_checked', 'mismatches', 'seconds_since_previous'], rows, {
      runs: rows.length,
      runs_with_mismatches: rows.filter((x) => Number(x.mismatches) > 0).length,
      longest_gap_seconds: rows.reduce((m, x) => Math.max(m, Number(x.seconds_since_previous ?? 0)), 0),
    });
  },
  'KC-21': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT action, payload->>'surface' AS surface, count(*)::int AS events
       FROM audit_events WHERE action IN ('ai.draft', 'ai.draft_accepted', 'ai.draft_rejected') AND ts >= $1 AND ts < $2
       GROUP BY 1, 2 ORDER BY 1, 2`,
      [from, to],
    );
    const orders = await db.query<{ n: string; bad: string }>(
      `SELECT count(*)::text AS n,
              count(*) FILTER (WHERE created_by !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')::text AS bad
       FROM orders WHERE source = 'ai-draft-accepted' AND created_at >= $1 AND created_at < $2`,
      [from, to],
    );
    const count = (a: string) => rows.filter((x) => x.action === a).reduce((s, x) => s + Number(x.events), 0);
    const drafts = count('ai.draft');
    const accepted = count('ai.draft_accepted');
    const rejected = count('ai.draft_rejected');
    return table(['action', 'surface', 'events'], rows, {
      drafts,
      accepted,
      rejected,
      acceptance_rate_pct: accepted + rejected > 0 ? Math.round((accepted / (accepted + rejected)) * 100) : null,
      ai_draft_orders: Number(orders[0]?.n ?? 0),
      ai_draft_orders_not_placed_by_a_user: Number(orders[0]?.bad ?? 0),
    });
  },
  'KC-22': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT payload->>'surface' AS surface, COALESCE(payload->>'modelId', '(none: ' || COALESCE(payload->>'status', '?') || ')') AS model,
              count(*)::int AS requests,
              count(*) FILTER (WHERE COALESCE((payload->>'ungroundedNumbers')::int, 0) > 0 OR COALESCE((payload->>'executionClaim')::boolean, false))::int AS flagged,
              count(*) FILTER (WHERE payload->>'status' = 'ok' AND payload->>'promptHash' IS NULL)::int AS without_prompt_hash
       FROM audit_events WHERE action = 'ai.request' AND ts >= $1 AND ts < $2 GROUP BY 1, 2 ORDER BY 3 DESC`,
      [from, to],
    );
    return table(['surface', 'model', 'requests', 'flagged', 'without_prompt_hash'], rows, {
      requests: rows.reduce((s, x) => s + Number(x.requests), 0),
      flagged: rows.reduce((s, x) => s + Number(x.flagged), 0),
    });
  },
  'KC-23': async ({ db, env }) => {
    const rows = await retentionReport(db, env);
    return table(
      ['id', 'label', 'classification', 'periodDays', 'placeholder', 'records', 'oldest', 'beyondPeriod', 'openQuestion', 'basis', 'disposal'],
      rows as unknown as Row[],
      {
        classes: rows.length,
        placeholders: rows.filter((x) => x.placeholder).length,
        records_beyond_period: rows.reduce((s, x) => s + x.beyondPeriod, 0),
      },
    );
  },
  'KC-24': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT id::text AS audit_id, ts, actor_id AS exported_by, entity_id AS subject_user, payload->>'mode' AS mode, payload->'sections' AS sections
       FROM audit_events WHERE action = 'privacy.subject_access_exported' AND ts >= $1 AND ts < $2 ORDER BY id`,
      [from, to],
    );
    return table(['audit_id', 'ts', 'exported_by', 'subject_user', 'mode', 'sections'], rows, { exports: rows.length });
  },
  'KC-25': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT ref, title, category, exercise, status, priority, detected_at, logged_at, classified_at, resolved_at, closed_at, review_ref,
              CASE WHEN resolved_at IS NULL THEN NULL ELSE round(extract(epoch FROM resolved_at - detected_at) / 60)::int END AS minutes_to_resolve
       FROM incidents WHERE logged_at >= $1 AND logged_at < $2 ORDER BY logged_at`,
      [from, to],
    );
    return table(
      ['ref', 'title', 'category', 'exercise', 'status', 'priority', 'detected_at', 'logged_at', 'classified_at', 'resolved_at', 'closed_at', 'minutes_to_resolve', 'review_ref'],
      rows,
      {
        incidents: rows.length,
        open: rows.filter((x) => x.status !== 'closed').length,
        p1_p2_closed_without_review: rows.filter((x) => x.status === 'closed' && (x.priority === 'P1' || x.priority === 'P2') && !x.review_ref).length,
      },
    );
  },
  'KC-26': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT id, kind, database, ok, artefact, bytes, sha256, tables_checked, rows_checked, recorded_by, started_at, finished_at
       FROM backup_runs WHERE finished_at >= $1 AND finished_at < $2 ORDER BY finished_at`,
      [from, to],
    );
    return table(['id', 'kind', 'database', 'ok', 'artefact', 'bytes', 'sha256', 'tables_checked', 'rows_checked', 'recorded_by', 'started_at', 'finished_at'], rows, {
      backups_ok: rows.filter((x) => x.kind === 'backup' && x.ok).length,
      restore_tests_ok: rows.filter((x) => x.kind === 'restore_test' && x.ok).length,
      failures: rows.filter((x) => !x.ok).length,
    });
  },
  'KC-27': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT disclosure_id, version, jurisdiction, locale, count(*)::int AS acknowledgements, count(DISTINCT user_id)::int AS users
       FROM disclosure_acknowledgements WHERE created_at >= $1 AND created_at < $2 GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`,
      [from, to],
    );
    const viol = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM orders o JOIN accounts a ON a.id = o.account_id
       WHERE o.created_at >= $1 AND o.created_at < $2 AND o.status <> 'rejected' AND NOT o.reduce_only AND o.source <> 'kill-switch'
         AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = a.user_id AND r.role IN ('trader','quant','risk_officer','admin'))
         AND NOT EXISTS (SELECT 1 FROM disclosure_acknowledgements d WHERE d.user_id = a.user_id AND d.disclosure_id = 'risk-warning' AND d.created_at <= o.created_at)`,
      [from, to],
    );
    return table(['disclosure_id', 'version', 'jurisdiction', 'locale', 'acknowledgements', 'users'], rows, {
      acknowledgements: rows.reduce((s, x) => s + Number(x.acknowledgements), 0),
      novice_orders_before_any_acknowledgement: Number(viol[0]?.n ?? 0),
    });
  },
  'KC-28': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT questionnaire_id, version, passed, count(*)::int AS attempts, count(DISTINCT user_id)::int AS users
       FROM questionnaire_attempts WHERE created_at >= $1 AND created_at < $2 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
      [from, to],
    );
    const viol = await db.query<Row>(
      `SELECT r.user_id::text AS user_id FROM user_roles r WHERE r.role = 'trader'
       AND NOT EXISTS (SELECT 1 FROM questionnaire_attempts q WHERE q.user_id = r.user_id AND q.questionnaire_id = 'appropriateness' AND q.passed)`,
    );
    return table(['questionnaire_id', 'version', 'passed', 'attempts', 'users'], rows, {
      attempts: rows.reduce((s, x) => s + Number(x.attempts), 0),
      traders_without_passed_assessment: viol.length,
    });
  },
  'KC-29': async ({ db }, { from, to }) => {
    const rows = await bestExecution(db, from, to, 'instrument');
    return table(['group', 'fills', 'mean_slippage', 'median_slippage', 'p95_slippage', 'mean_slippage_bps', 'p95_slippage_bps', 'adverse_share_pct'], rows as unknown as Row[], {
      fills: rows.reduce((s, x) => s + x.fills, 0),
      instruments: rows.length,
    });
  },
  'KC-30': async ({ db, liveTradingEnabled }) => {
    const r = await db.query<Row>(
      `SELECT (SELECT count(*)::int FROM accounts WHERE environment = 'LIVE') AS live_accounts,
              (SELECT count(*)::int FROM robots WHERE mode = 'LIVE') AS live_robots,
              (SELECT count(*)::int FROM compliance_signoffs WHERE revoked_at IS NULL) AS active_compliance_signoffs`,
    );
    const row = { ...r[0], live_trading_enabled_flag: liveTradingEnabled, checked_at: new Date() };
    return table(['live_accounts', 'live_robots', 'active_compliance_signoffs', 'live_trading_enabled_flag', 'checked_at'], [row], {
      live_accounts: Number(r[0]?.live_accounts ?? 0),
      live_robots: Number(r[0]?.live_robots ?? 0),
      live_trading_enabled_flag: liveTradingEnabled,
    });
  },
  'KC-31': async ({ db }, { from, to }) => {
    const rows = await db.query<Row>(
      `SELECT id::text AS audit_id, ts, actor_id, action, payload->>'controlId' AS control_id, payload->>'format' AS format,
              payload->>'n' AS sample_size, payload->>'seed' AS seed
       FROM audit_events WHERE action IN ('internal_audit.sample_drawn', 'governance.evidence_exported') AND ts >= $1 AND ts < $2 ORDER BY id`,
      [from, to],
    );
    return table(['audit_id', 'ts', 'actor_id', 'action', 'control_id', 'format', 'sample_size', 'seed'], rows, {
      samples: rows.filter((x) => x.action === 'internal_audit.sample_drawn').length,
      exports: rows.filter((x) => x.action === 'governance.evidence_exported').length,
      controls_covered: new Set(rows.map((x) => x.control_id).filter(Boolean)).size,
    });
  },
};

async function fourEyes(db: DbService, { from, to }: Range, kinds: string[]): Promise<EvidenceTable> {
  const rows = await db.query<Row>(
    `SELECT id, kind, subject_type, subject_id, requested_by, requested_at, status, decided_by, decided_at, reason, decision_note
     FROM four_eyes_requests WHERE kind = ANY($3::text[]) AND requested_at >= $1 AND requested_at < $2 ORDER BY requested_at`,
    [from, to, kinds],
  );
  return table(
    ['id', 'kind', 'subject_type', 'subject_id', 'requested_by', 'requested_at', 'status', 'decided_by', 'decided_at', 'reason', 'decision_note'],
    rows,
    {
      requests: rows.length,
      approved: rows.filter((x) => x.status === 'approved').length,
      requester_equals_approver: rows.filter((x) => (x.status === 'approved' || x.status === 'rejected') && x.decided_by === x.requested_by).length,
    },
  );
}

export interface BestExecutionRow {
  group: string;
  fills: number;
  mean_slippage: string | null;
  median_slippage: string | null;
  p95_slippage: string | null;
  mean_slippage_bps: string | null;
  p95_slippage_bps: string | null;
  adverse_share_pct: string | null;
}

/**
 * Best-execution report data (goal 09): slippage of fills against the reference price at decision
 * time (goal 03 `fills.slippage`, positive = adverse), by instrument or by UTC hour of day.
 */
export async function bestExecution(db: DbService, from: Date, to: Date, groupBy: 'instrument' | 'hour'): Promise<BestExecutionRow[]> {
  const key = groupBy === 'instrument' ? 'symbol' : `lpad(extract(hour FROM ts AT TIME ZONE 'UTC')::int::text, 2, '0') || ':00 UTC'`;
  return db.query<BestExecutionRow>(
    `SELECT ${key} AS "group", count(*)::int AS fills,
            round(avg(slippage), 8)::text AS mean_slippage,
            round((percentile_cont(0.5) WITHIN GROUP (ORDER BY slippage))::numeric, 8)::text AS median_slippage,
            round((percentile_cont(0.95) WITHIN GROUP (ORDER BY slippage))::numeric, 8)::text AS p95_slippage,
            round(avg(slippage / NULLIF(reference_price, 0) * 10000), 3)::text AS mean_slippage_bps,
            round((percentile_cont(0.95) WITHIN GROUP (ORDER BY slippage / NULLIF(reference_price, 0) * 10000))::numeric, 3)::text AS p95_slippage_bps,
            round(100.0 * count(*) FILTER (WHERE slippage > 0) / count(*), 2)::text AS adverse_share_pct
     FROM fills WHERE ts >= $1 AND ts < $2 GROUP BY 1 ORDER BY 1`,
    [from, to],
  );
}

export { iso };
