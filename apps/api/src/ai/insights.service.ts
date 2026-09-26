import { Injectable } from '@nestjs/common';
import type { Role } from '@kora/domain';

import { CalibrationService } from './calibration.service';
import type { CalibrationView } from './core/calibration';
import { AiReadPorts } from './read-ports';

export interface Suggestion {
  code:
    | 'reduce_risk_until_live_evidence'
    | 'no_edge_keep_paused'
    | 'overfitting_caution'
    | 'insufficient_history';
  title: string;
  detail: string;
  /** A draft the user can ask for (never applied automatically). */
  draft: { kind: 'strategy'; param: string; from: number; to: number } | null;
  evidence: Record<string, number | string | null>;
}

const MIN_LIVE_TRADES = 100;
const n = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/**
 * Robots copilot drawer (goal 07 §5): calibrated confidence for the robot's strategy, data-derived
 * suggestions ("reduce risk until 100 live trades"), and the scan for robots with no edge after
 * costs. Rules are code over stored numbers; the model is only asked to explain them.
 */
@Injectable()
export class InsightsService {
  constructor(
    private readonly ports: AiReadPorts,
    private readonly calibration: CalibrationService,
  ) {}

  async robot(userId: string, roles: Role[], robotId: string, minN: number) {
    const d = await this.ports.robotDetail(userId, roles, robotId);
    const modelKey = await this.calibration.ensureStrategy(userId, roles, d.strategyId);
    const signals = await this.ports.robotSignals(userId, roles, robotId, 50);
    const latest = signals.signals.find((s) => s.action !== 'hold') ?? signals.signals[0] ?? null;
    let rawScore: number | null = null;
    if (latest) {
      const conds = (
        (latest.conditions as Array<{ result?: unknown; contribution?: number | null }>) ?? []
      ).filter((c) => c.result === true);
      const xs = conds.map((c) => c.contribution).filter((c): c is number => typeof c === 'number');
      rawScore = xs.length
        ? Math.round(((xs.reduce((a, b) => a + b, 0) / xs.length + 1) / 2) * 1e5) / 1e5
        : null;
    }
    const view = await this.calibration.view(modelKey, rawScore, minN);
    const strategy = await this.ports.strategy(userId, roles, d.strategyId);
    const params =
      (
        strategy.versions[0]?.definition as
          | { params?: Record<string, { value: number; min?: number }> }
          | undefined
      )?.params ?? {};
    return {
      robotId: d.id,
      name: d.name,
      strategyId: d.strategyId,
      latestSignalId: latest?.id ?? null,
      calibration: view,
      suggestions: this.suggestions(d, view, params),
      disclaimer: 'Not investment advice.',
    };
  }

  suggestions(
    d: { kpis: { inSample: unknown; outOfSample: unknown; live: { fills: number } } },
    view: CalibrationView,
    params: Record<string, { value: number; min?: number }>,
  ): Suggestion[] {
    const out: Suggestion[] = [];
    const is = (d.kpis.inSample ?? {}) as Record<string, unknown>;
    const oos = (d.kpis.outOfSample ?? {}) as Record<string, unknown>;
    const isS = n(is.sharpe);
    const oosS = n(oos.sharpe);
    const liveTrades = d.kpis.live.fills;
    const riskParam = Object.keys(params).find((k) => /risk/i.test(k));
    if (view.edge === 'none') {
      out.push({
        code: 'no_edge_keep_paused',
        title: 'No edge detected after costs',
        detail: `Over ${view.n} resolved out-of-sample trades the average result after costs was ${view.meanNetReturn} R. Keeping the robot paused until the rules change is the cautious option.`,
        draft: null,
        evidence: { n: view.n, meanNetReturnR: view.meanNetReturn, tStat: view.tStat },
      });
    } else if (view.edge === 'insufficient_data') {
      out.push({
        code: 'insufficient_history',
        title: 'Not enough history to calibrate',
        detail: view.edgeStatement,
        draft: null,
        evidence: { n: view.n, minN: view.minN },
      });
    }
    if (isS !== null && oosS !== null && isS > 0 && oosS < isS && liveTrades < MIN_LIVE_TRADES) {
      const drop = Math.round((1 - oosS / isS) * 100);
      const cur = riskParam ? params[riskParam]!.value : null;
      const to =
        cur !== null
          ? Math.max(params[riskParam!]!.min ?? 0.01, Math.round(cur * (2 / 3) * 100) / 100)
          : null;
      out.push({
        code: 'reduce_risk_until_live_evidence',
        title: `Reduce risk until ${MIN_LIVE_TRADES} live trades`,
        detail: `Out-of-sample Sharpe (${oosS}) is ${drop}% lower than in-sample (${isS}) and there are ${liveTrades} live fills. A smaller risk per trade${cur !== null ? ` (${cur} → ${to})` : ''} until ${MIN_LIVE_TRADES} live trades confirm the edge limits the damage if the edge is weaker than tested.`,
        draft:
          riskParam && cur !== null && to !== null && to < cur
            ? { kind: 'strategy', param: riskParam, from: cur, to }
            : null,
        evidence: { isSharpe: isS, oosSharpe: oosS, dropPct: drop, liveFills: liveTrades },
      });
    }
    const dsr = n((d.kpis as { overfitting?: { dsr?: unknown } }).overfitting?.dsr);
    if (dsr !== null && dsr < 0.95) {
      out.push({
        code: 'overfitting_caution',
        title: 'Overfitting caution',
        detail: `The deflated Sharpe ratio is ${dsr}, below 0.95: part of the backtest result may come from trying many variants.`,
        draft: null,
        evidence: { dsr },
      });
    }
    return out;
  }

  /** Every robot of the user whose strategy shows no edge after costs (or too little history). */
  async scanNoEdge(userId: string, roles: Role[], minN: number) {
    const { robots } = await this.ports.robotList(userId);
    const results = [];
    for (const r of robots) {
      const key = await this.calibration.ensureStrategy(userId, roles, r.strategyId);
      const v = await this.calibration.view(key, null, minN);
      results.push({
        robotId: r.id,
        name: r.name,
        status: r.status,
        strategyId: r.strategyId,
        edge: v.edge,
        n: v.n,
        meanNetReturn: v.meanNetReturn,
        tStat: v.tStat,
        statement: v.edgeStatement,
        recommendation:
          v.edge === 'none'
            ? r.status === 'running'
              ? 'Consider pausing it and revisiting the rules.'
              : 'Keeping it paused is the cautious option.'
            : v.edge === 'insufficient_data'
              ? 'Not enough out-of-sample trades to judge. Run a longer backtest.'
              : 'Positive after costs on past trades; keep monitoring tracking error.',
      });
    }
    return {
      robots: results,
      flagged: results.filter((r) => r.edge !== 'positive').length,
      disclaimer: 'Not investment advice.',
    };
  }
}
