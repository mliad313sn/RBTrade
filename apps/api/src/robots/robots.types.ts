import { shortHash, type RobotLimits, type RobotMode, type RobotStatus } from '@kora/domain';

export interface RobotRow {
  id: string;
  owner_id: string;
  account_id: string;
  strategy_id: string;
  version_id: string;
  name: string;
  mode: RobotMode;
  status: RobotStatus;
  allocation: string;
  limits: RobotLimits;
  limits_hash: string;
  peak_equity: string | null;
  day_start: string | null;
  day_start_equity: string | null;
  week_start: string | null;
  week_start_equity: string | null;
  pause_reason: string | null;
  paused_at: Date | null;
  started_at: Date | null;
  paper_started_at: Date | null;
  last_heartbeat_at: Date | null;
  created_at: Date;
  updated_at: Date;
  /** Goal 08: 'novice_template' robots come from the guarded /novice/auto-invest path (B-614). */
  origin: 'builder' | 'novice_template';
  template_id: string | null;
}

export interface RobotJoinRow extends RobotRow {
  strategy_name: string;
  version: number;
  content_hash: string;
  timeframe: string;
  symbols: string[];
}

export const robotSource = (id: string): `robot:${string}` => `robot:${id}`;

export function robotDto(r: RobotJoinRow) {
  return {
    id: r.id,
    name: r.name,
    ownerId: r.owner_id,
    accountId: r.account_id,
    strategyId: r.strategy_id,
    strategyName: r.strategy_name,
    versionId: r.version_id,
    version: r.version,
    contentHash: r.content_hash,
    shortHash: shortHash(r.content_hash),
    symbols: r.symbols,
    timeframe: r.timeframe,
    mode: r.mode,
    status: r.status,
    allocation: r.allocation,
    origin: r.origin,
    templateId: r.template_id,
    limits: r.limits,
    limitsHash: r.limits_hash,
    pauseReason: r.pause_reason,
    pausedAt: r.paused_at?.toISOString() ?? null,
    startedAt: r.started_at?.toISOString() ?? null,
    paperStartedAt: r.paper_started_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    environment: 'PAPER' as const,
  };
}

export const ROBOT_SELECT = `SELECT r.*, s.name AS strategy_name, v.version, v.content_hash,
  v.definition->'universe'->>'timeframe' AS timeframe,
  ARRAY(SELECT jsonb_array_elements_text(v.definition->'universe'->'symbols')) AS symbols
  FROM robots r JOIN strategies s ON s.id = r.strategy_id JOIN strategy_versions v ON v.id = r.version_id`;
