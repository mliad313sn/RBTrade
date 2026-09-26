import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { dec } from '@kora/domain';
import type { Redis } from 'ioredis';

import { DbService } from '../db/db.service';
import { AccountsService } from '../trading/accounts.service';
import { ROBOT_CONTROL_CHANNEL } from '../trading/trading-events.service';
import { RobotBookService } from './robot-book.service';
import { RobotControlService, type RobotControlMessage } from './robot-control.service';
import { heartbeatMs, RobotsService } from './robots.service';
import type { RobotRow } from './robots.types';

export const MISSED_BEATS = 3;

export function supervisorMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.KORA_ROBOT_SUPERVISOR_MS ?? '');
  return Number.isInteger(n) && n >= 0 ? n : 1000;
}

const isoWeekStart = (d: Date): string => {
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day))
    .toISOString()
    .slice(0, 10);
};

/**
 * Watches running robots (goal 06 §7): heartbeats (3 missed → pause + alert), per-robot loss and
 * drawdown limits (breach → auto-pause + alert), and the kill switch (`kora:ctl:robots` halt →
 * every running robot of the account is paused and audited). The runner reacts to the same halt
 * message on its own; this keeps the database state and the audit trail in step.
 */
@Injectable()
export class RobotSupervisorService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('RobotSupervisor');
  private timer: NodeJS.Timeout | null = null;
  private sub: Redis | null = null;
  private busy = false;

  constructor(
    private readonly db: DbService,
    private readonly robots: RobotsService,
    private readonly book: RobotBookService,
    private readonly accounts: AccountsService,
    private readonly control: RobotControlService,
  ) {}

  onModuleInit(): void {
    const ms = supervisorMs();
    if (ms > 0) {
      this.timer = setInterval(() => void this.tick(), ms);
      this.timer.unref();
    }
    if (process.env.KORA_ROBOT_SUPERVISOR_CONTROL !== 'off') {
      this.sub = this.control.subscriber();
      void this.sub
        .subscribe(ROBOT_CONTROL_CHANNEL)
        .catch((e: Error) => this.log.warn(`subscribe failed: ${e.message}`));
      this.sub.on('message', (_ch: string, raw: string) => void this.onControl(raw));
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.sub?.disconnect();
  }

  private async onControl(raw: string): Promise<void> {
    let msg: RobotControlMessage;
    try {
      msg = JSON.parse(raw) as RobotControlMessage;
    } catch {
      return;
    }
    if (msg.action !== 'halt' || !msg.accountId) return;
    const running = await this.db.query<{ id: string }>(
      `SELECT id FROM robots WHERE account_id = $1 AND status = 'running'`,
      [msg.accountId],
    );
    for (const r of running)
      await this.robots
        .pauseRobot(
          r.id,
          'kill_switch',
          { type: 'system', id: 'kill-switch' },
          { scope: msg.scope ?? null, killSwitchAuditEventId: msg.auditEventId ?? null },
        )
        .catch((e: Error) => this.log.warn(`pause after halt failed: ${e.message}`));
  }

  /** One supervision pass (exposed for tests). */
  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const running = await this.db.query<RobotRow>(
        `SELECT * FROM robots WHERE status = 'running'`,
      );
      if (!running.length) return;
      const beats = await this.control.heartbeats(running.map((r) => r.id));
      const hb = heartbeatMs();
      for (const r of running) {
        try {
          await this.checkHeartbeat(r, beats.get(r.id), hb, now);
          await this.checkLimits(r, now);
        } catch (e) {
          this.log.warn(`supervision of ${r.id} failed: ${(e as Error).message}`);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async checkHeartbeat(
    r: RobotRow,
    last: number | undefined,
    hb: number,
    now: number,
  ): Promise<void> {
    const grace = MISSED_BEATS * hb;
    const since = r.started_at?.getTime() ?? now;
    const lastSeen = last ?? since;
    if (now - since <= grace || now - lastSeen <= grace) return;
    await this.robots.pauseRobot(
      r.id,
      'heartbeat_lost',
      { type: 'system', id: 'robot-supervisor' },
      {
        lastHeartbeatAt: last ? new Date(last).toISOString() : null,
        missedBeats: Math.floor((now - lastSeen) / hb),
      },
      {
        severity: 'critical',
        message: `Robot ${r.name} paused: no heartbeat from the bot runner for ${Math.round((now - lastSeen) / 1000)} s.`,
      },
    );
  }

  private async checkLimits(r: RobotRow, now: number): Promise<void> {
    const fresh = (
      await this.db.query<RobotRow>(`SELECT * FROM robots WHERE id = $1 AND status = 'running'`, [
        r.id,
      ])
    )[0];
    if (!fresh) return;
    const account = await this.accounts.byId(fresh.account_id);
    if (!account) return;
    const b = await this.book.book(fresh, account.base_currency);
    const eq = b.equity;
    const d = new Date(now);
    const today = d.toISOString().slice(0, 10);
    const week = isoWeekStart(d);
    const peak = fresh.peak_equity && dec(fresh.peak_equity).gt(eq) ? dec(fresh.peak_equity) : eq;
    const dayStart =
      fresh.day_start === today && fresh.day_start_equity ? dec(fresh.day_start_equity) : eq;
    const weekStart =
      fresh.week_start === week && fresh.week_start_equity ? dec(fresh.week_start_equity) : eq;
    await this.db.query(
      `UPDATE robots SET peak_equity = $2::numeric, day_start = $3, day_start_equity = $4::numeric, week_start = $5, week_start_equity = $6::numeric
       WHERE id = $1`,
      [fresh.id, peak.toFixed(10), today, dayStart.toFixed(10), week, weekStart.toFixed(10)],
    );
    const l = fresh.limits;
    const ddPct = peak.gt(0) ? peak.sub(eq).div(peak).mul(100) : dec('0');
    const breach = ddPct.gte(dec(String(l.maxDrawdownPct)))
      ? { reason: 'max_drawdown', detail: `drawdown ${ddPct.toFixed(2)}% ≥ ${l.maxDrawdownPct}%` }
      : dayStart.sub(eq).gte(dec(l.dailyLoss))
        ? {
            reason: 'daily_loss_limit',
            detail: `day loss ${dayStart.sub(eq).toFixed(2)} ≥ ${l.dailyLoss}`,
          }
        : weekStart.sub(eq).gte(dec(l.weeklyLoss))
          ? {
              reason: 'weekly_loss_limit',
              detail: `week loss ${weekStart.sub(eq).toFixed(2)} ≥ ${l.weeklyLoss}`,
            }
          : null;
    if (!breach) return;
    await this.robots.pauseRobot(
      fresh.id,
      breach.reason,
      { type: 'system', id: 'robot-supervisor' },
      {
        equity: eq.toFixed(2),
        peakEquity: peak.toFixed(2),
        drawdownPct: ddPct.toFixed(2),
        detail: breach.detail,
      },
      {
        severity: 'critical',
        message: `Robot ${fresh.name} auto-paused: ${breach.detail}. Its protective stops stay in place.`,
      },
    );
  }
}
