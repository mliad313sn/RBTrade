/**
 * Formatting for SIMULATED research statistics (floats). Booked money keeps using formatMoney/Decimal.
 * Signs are always explicit (+/−) so colour is never the only cue.
 */

const minus = '−';

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v < 0 ? `${minus}${Math.abs(v).toFixed(digits)}` : v.toFixed(digits);
}

export function fmtSigned(v: number | null | undefined, digits = 2, suffix = ''): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = Math.abs(v).toFixed(digits);
  return `${v > 0 ? '+' : v < 0 ? minus : ''}${s}${suffix}`;
}

/** Fraction → percent: 0.184 → "18.4%". */
export function fmtRatioPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${fmtNum(v * 100, digits)}%`;
}

export function fmtDays(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${Math.round(v)} d`;
}

export function fmtR(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${fmtSigned(v, 2)} R`;
}

/** Plain-language reason for a paused robot. */
export const PAUSE_REASONS: Record<string, string> = {
  kill_switch: 'Kill switch',
  heartbeat_lost: 'Runner heartbeat lost',
  max_drawdown: 'Max drawdown limit',
  daily_loss_limit: 'Daily loss limit',
  weekly_loss_limit: 'Weekly loss limit',
  owner_role_revoked: 'Owner role revoked',
};

export function pauseLabel(reason: string | null): string {
  if (!reason) return '';
  return PAUSE_REASONS[reason] ?? reason;
}

/** Audit action → prototype tag (RECONCILE, OVERRIDE, ORDER, SIGNAL, PARAM, RISK). */
export function auditTag(action: string): string {
  if (action.startsWith('order.')) return 'ORDER';
  if (action === 'robot.signal') return 'SIGNAL';
  if (action.startsWith('strategy.') || action === 'robot.version_changed') return 'PARAM';
  if (action.startsWith('backtest.')) return 'TEST';
  if (
    action.startsWith('robot.risk') ||
    action.startsWith('robot.limits') ||
    action === 'robot.auto_paused' ||
    action.startsWith('robot.promotion')
  )
    return 'RISK';
  if (action.startsWith('kill_switch')) return 'HALT';
  if (action === 'robot.paused' || action === 'robot.started') return 'OVERRIDE';
  return action.split('.')[0]!.toUpperCase();
}

export function auditText(e: { action: string; payload: Record<string, unknown> }): string {
  const p = e.payload;
  switch (e.action) {
    case 'strategy.version_created': {
      const changes =
        (p.paramsChanged as
          | Array<{ name: string; from: string | null; to: string | null }>
          | undefined) ?? [];
      const diff = changes
        .slice(0, 3)
        .map((c) => `${c.name} ${c.from ?? '∅'} → ${c.to ?? '∅'}`)
        .join(', ');
      return `v${String(p.version)} #${String(p.contentHash ?? '').slice(0, 6)}${diff ? ` (${diff})` : ''} · ${String(p.reason ?? '')}`;
    }
    case 'strategy.created':
      return `Strategy ${String(p.name ?? '')} created`;
    case 'robot.signal':
      return `${String(p.action)} ${String(p.symbol)} · ${String(p.outcome)}${p.code ? ` (${String(p.code)})` : ''}`;
    case 'robot.paused':
    case 'robot.auto_paused':
      return `Paused · ${pauseLabel(String(p.reason ?? '')) || String(p.reason ?? '')}`;
    case 'robot.started':
      return 'Started (PAPER)';
    case 'order.new':
      return `${String(p.side ?? '').toUpperCase()} ${String(p.qty ?? '')} ${String(p.symbol ?? '')} (${String(p.type ?? '')})`;
    case 'backtest.run':
    case 'backtest.walk_forward':
    case 'backtest.optimise':
    case 'backtest.sensitivity':
      return `${e.action.replace('backtest.', '').replace('_', '-')} · trials ${String(p.trialsTotal ?? '')}`;
    default:
      return e.action;
  }
}
