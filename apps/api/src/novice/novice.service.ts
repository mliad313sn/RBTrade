import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  buildNoviceOrder,
  changeSinceStart,
  dec,
  effectiveOwnLimits,
  formatAmount,
  minimumAmount,
  pendingChanges,
  PreviewOrderSchema,
  scenarioGain,
  sessionStatus,
  suggestedLimit,
  worstDip,
  type AttemptRequest,
  type NoviceDirection,
  type Role,
  type StoredLimits,
} from '@kora/domain';

import { QuestionnaireService } from '../appropriateness/questionnaire.service';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { DisclosureAcknowledgements } from '../disclosures/acknowledgements.service';
import { AccountsService } from '../trading/accounts.service';
import { FxService } from '../trading/fx.service';
import { MarketViewService } from '../trading/market-view.service';
import { OmsService } from '../trading/oms.service';
import { TRADING_CONFIG, type TradingConfig } from '../trading/trading-config';
import { TradingRegistryService } from '../trading/trading-registry.service';
import type { AccountRow } from '../trading/trading.types';
import {
  KNOWLEDGE_CHECK_ID,
  NOVICE_CONFIG,
  RISK_WARNING_ID,
  type NoviceConfig,
} from './novice-config';

export interface Caller {
  sub: string;
  roles: Role[];
}

interface NoviceName {
  en: string;
  fr: string;
}

/**
 * Novice view API (goal 08): profile (onboarding, limits, cooling-off, borrowing, knowledge check),
 * home summary, the curated asset list, the server-built trade ticket, and the knowledge check.
 * Every guardrail is enforced by the OMS risk path; this service only reports and requests.
 */
@Injectable()
export class NoviceService {
  constructor(
    @Inject(NOVICE_CONFIG) private readonly cfg: NoviceConfig,
    @Inject(TRADING_CONFIG) private readonly tcfg: TradingConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly oms: OmsService,
    private readonly registry: TradingRegistryService,
    private readonly market: MarketViewService,
    private readonly fx: FxService,
    private readonly acks: DisclosureAcknowledgements,
    private readonly q: QuestionnaireService,
  ) {}

  private async onboardedAt(userId: string): Promise<Date | null> {
    const r = await this.db.query<{ onboarded_at: Date | null }>(
      'SELECT onboarded_at FROM novice_profiles WHERE user_id = $1',
      [userId],
    );
    return r[0]?.onboarded_at ?? null;
  }

  async isOnboarded(userId: string): Promise<boolean> {
    return (await this.onboardedAt(userId)) !== null;
  }

  private knowledgeDef() {
    void this.q.ensureSynced().catch(() => undefined);
    const d = this.q.get(KNOWLEDGE_CHECK_ID);
    if (!d)
      throw new NotFoundException({
        error: 'not_found',
        message: 'No knowledge check is published.',
      });
    return d;
  }

  async knowledgeStatus(userId: string) {
    const def = this.knowledgeDef();
    const last = await this.q.lastAttempt(userId, KNOWLEDGE_CHECK_ID);
    const cooldownUntil = this.q.cooldownUntil(def, last);
    const passed = !!last?.passed;
    return {
      passed,
      eligible: !passed && !cooldownUntil,
      cooldownUntil: cooldownUntil?.toISOString() ?? null,
      lastAttempt: last
        ? {
            version: last.version,
            scorePct: last.score_pct,
            passed: last.passed,
            at: last.created_at.toISOString(),
          }
        : null,
    };
  }

  async profile(c: Caller) {
    const account = await this.accounts.ensure(c.sub);
    const now = Date.now();
    const v = await this.accounts.value(account, undefined, now);
    const guard = await this.accounts.guardState(account, v, now);
    const limits = this.accounts.limits(account, now);
    const stored = account.risk_limits as StoredLimits;
    const own = effectiveOwnLimits(stored, now);
    const pending = pendingChanges(stored, now);
    const ccy = account.base_currency;
    const m = (d: ReturnType<typeof dec>) => formatAmount(d, ccy);
    const loss = (d: ReturnType<typeof dec>) => (d.isNegative() ? d.neg() : dec(0));
    const onboardedAt = await this.onboardedAt(c.sub);
    const leveragePending = pending.find((p) => p.field === 'noviceMaxLeverage');
    const knowledge = await this.knowledgeStatus(c.sub);
    const balance = v.summary.equity.toFixed();
    return {
      guarded: await this.oms.isNovice(c.sub, c.roles),
      currency: ccy,
      environment: 'PAPER' as const,
      simulated: true,
      onboarding: {
        completed: onboardedAt !== null,
        completedAt: onboardedAt?.toISOString() ?? null,
        disclosureAcknowledged: await this.acks.isCurrent(c.sub, RISK_WARNING_ID),
        limitsSet: own.dailyLossLimit !== undefined && own.monthlyLossLimit !== undefined,
      },
      suggestedLimits: {
        daily: suggestedLimit(balance, this.cfg.suggestedDailyLossPct),
        monthly: suggestedLimit(balance, this.cfg.suggestedMonthlyLossPct),
        dailyPct: this.cfg.suggestedDailyLossPct,
        monthlyPct: this.cfg.suggestedMonthlyLossPct,
        simulated: true,
      },
      limits: {
        daily: { limit: limits.dailyLossLimit, used: m(loss(v.dayPnl)) },
        monthly: { limit: limits.monthlyLossLimit ?? null, used: m(loss(v.monthPnl)) },
        pending,
        loosenDelayHours: this.tcfg.novice.loosenDelayMs / 3_600_000,
      },
      coolingOff: guard.coolingOff,
      leverage: {
        state: dec(guard.noviceMaxLeverage).gt(1)
          ? 'on'
          : leveragePending
            ? 'pending'
            : ('off' as const),
        current: guard.noviceMaxLeverage,
        max: this.tcfg.novice.maxLeverage,
        effectiveAt: leveragePending?.effectiveAt ?? null,
        requiresKnowledgeCheck: true,
      },
      knowledgeCheck: knowledge,
    };
  }

  async completeOnboarding(c: Caller) {
    const p = await this.profile(c);
    const missing = [
      ...(p.onboarding.disclosureAcknowledged ? [] : ['disclosure']),
      ...(p.onboarding.limitsSet ? [] : ['limits']),
    ];
    if (missing.length)
      throw new ConflictException({
        error: 'onboarding_incomplete',
        message:
          'Read and confirm the risk warning and set your daily and monthly loss limits first.',
        missing,
      });
    await this.db.tx(async (tx) => {
      const r = await tx.query<{ onboarded_at: Date }>(
        `INSERT INTO novice_profiles (user_id, onboarded_at) VALUES ($1, now())
         ON CONFLICT (user_id) DO UPDATE SET onboarded_at = COALESCE(novice_profiles.onboarded_at, now()), updated_at = now()
         RETURNING onboarded_at`,
        [c.sub],
      );
      await this.audit.record(
        {
          actorId: c.sub,
          actorType: 'user',
          action: 'novice.onboarding_completed',
          entity: 'user',
          entityId: c.sub,
          payload: {
            onboardedAt: r.rows[0]!.onboarded_at.toISOString(),
            dailyLossLimit: p.limits.daily.limit,
            monthlyLossLimit: p.limits.monthly.limit,
            disclosureId: RISK_WARNING_ID,
          },
        },
        tx,
      );
    });
    return this.profile(c);
  }

  /** Daily / monthly loss limits: tightening now, loosening after the wait (guarded users). */
  async setLimits(c: Caller, body: { dailyLossLimit?: string; monthlyLossLimit?: string }) {
    const guarded = await this.oms.isNovice(c.sub, c.roles);
    await this.accounts.updateSettings(c.sub, { riskLimits: body }, { guarded });
    return this.profile(c);
  }

  /** Borrowing: on needs a passed knowledge check and waits 24 h (a loosening); off is immediate. */
  async setLeverage(c: Caller, enabled: boolean) {
    if (enabled) {
      const k = await this.knowledgeStatus(c.sub);
      if (!k.passed)
        throw new ForbiddenException({
          error: 'knowledge_check_required',
          message: 'Pass the 5-question check before you can ask to borrow.',
        });
    }
    await this.accounts.updateSettings(
      c.sub,
      {},
      {
        guarded: true,
        extraLimits: { noviceMaxLeverage: enabled ? this.tcfg.novice.maxLeverage : '1' },
      },
    );
    return this.profile(c);
  }

  async summary(c: Caller) {
    const account = await this.accounts.ensure(c.sub);
    const v = await this.accounts.value(account);
    const ccy = account.base_currency;
    const snaps = await this.db.query<{ period_start: string; equity: string }>(
      `SELECT to_char(period_start, 'YYYY-MM-DD') AS period_start, equity::text AS equity FROM account_equity_snapshots
       WHERE account_id = $1 AND period = 'day' ORDER BY period_start LIMIT 400`,
      [account.id],
    );
    const series = [
      { t: account.created_at.toISOString(), equity: dec(account.starting_cash).toFixed() },
      ...snaps.map((s) => ({ t: `${s.period_start}T00:00:00.000Z`, equity: s.equity })),
      { t: new Date().toISOString(), equity: v.summary.equity.toFixed() },
    ];
    const positions = await this.accounts.positionsView(account);
    const names = await this.names(positions.map((p) => p.symbol));
    const holdings = [];
    for (const p of positions) {
      const inst = await this.registry.get(p.symbol);
      holdings.push({
        symbol: p.symbol,
        name: names.get(p.symbol) ?? null,
        displayName: inst.spec.displayName,
        assetClass: inst.spec.assetClass,
        /** "You gain if it goes up" for a long position, "down" for a short one. */
        gainsIf: dec(p.qty).isPositive() ? ('up' as const) : ('down' as const),
        value: p.notional,
        unrealizedPnl: p.unrealizedPnl,
        stale: p.stale,
      });
    }
    const start = dec(account.starting_cash).toFixed();
    return {
      currency: ccy,
      simulated: true,
      startedAt: account.created_at.toISOString(),
      startingBalance: formatAmount(dec(start), ccy),
      balance: formatAmount(v.summary.equity, ccy),
      changeSinceStart: changeSinceStart(start, v.summary.equity.toFixed(), ccy),
      worstDip: worstDip(series, ccy),
      series: series.map((s) => ({ t: s.t, equity: formatAmount(dec(s.equity), ccy) })),
      holdings,
    };
  }

  private async names(symbols: string[]): Promise<Map<string, NoviceName>> {
    if (!symbols.length) return new Map();
    const r = await this.db.query<{ symbol: string; novice_name: NoviceName | null }>(
      'SELECT symbol, novice_name FROM instruments WHERE symbol = ANY($1::text[])',
      [symbols],
    );
    return new Map(r.filter((x) => x.novice_name).map((x) => [x.symbol, x.novice_name!]));
  }

  /** The curated novice list from the registry, with session state and the minimum amount. */
  async assets(c: Caller) {
    const account = await this.accounts.ensure(c.sub);
    const rows = await this.db.query<{
      symbol: string;
      novice_rank: number;
      novice_name: NoviceName;
    }>(
      `SELECT symbol, novice_rank, novice_name FROM instruments
       WHERE novice_rank IS NOT NULL AND status = 'active' ORDER BY novice_rank`,
    );
    const out = [];
    const now = Date.now();
    for (const r of rows) {
      const inst = await this.registry.find(r.symbol);
      if (!inst) continue;
      const snap = await this.market.snapshot(inst, now);
      const tz = inst.spec.tradingSessions?.timezone ?? inst.venue.timezone;
      const session = sessionStatus(inst.spec.tradingSessions ?? inst.venue.calendar, tz, now);
      const rate = await this.fx.rate(inst.spec.quoteCcy, account.base_currency, now);
      const minAmount =
        snap.bid && snap.ask && rate
          ? minimumAmount({
              direction: 'up',
              bid: snap.bid.toFixed(),
              ask: snap.ask.toFixed(),
              minQty: inst.spec.minQty,
              multiplier: inst.multiplier.toFixed(),
              fxRate: rate.rate.toFixed(),
              accountCcy: account.base_currency,
            })
          : null;
      out.push({
        symbol: r.symbol,
        rank: r.novice_rank,
        name: r.novice_name,
        displayName: inst.spec.displayName,
        assetClass: inst.spec.assetClass,
        quoteCcy: inst.spec.quoteCcy,
        venue: {
          mic: inst.venue.mic,
          name: inst.venue.name,
          region: inst.venue.region,
          timezone: tz,
        },
        session: snap.session,
        nextChange: session.nextChange,
        priced: !!(snap.bid && snap.ask),
        dataState: snap.safety,
        minAmount,
      });
    }
    return { currency: account.base_currency, assets: out, simulated: true };
  }

  /**
   * The novice ticket: amount (account currency) + safety net (%) → the exact market order with its
   * stop, plus the unchanged `/orders/preview` answer for that order. "Most you could lose" is
   * `preview.preview.lossIfStopHit.total` (price loss + fees); the client places exactly `order`.
   */
  async ticket(
    c: Caller,
    body: { symbol: string; direction: NoviceDirection; amount: string; safetyNetPct: string },
  ) {
    const account: AccountRow = await this.accounts.ensure(c.sub);
    const inst = await this.registry.get(body.symbol);
    const now = Date.now();
    const snap = await this.market.snapshot(inst, now);
    if (!snap.bid || !snap.ask)
      return { ok: false as const, reason: 'no_price' as const, minAmount: null };
    const rate = await this.fx.rate(inst.spec.quoteCcy, account.base_currency, now);
    if (!rate) return { ok: false as const, reason: 'no_fx' as const, minAmount: null };
    const built = buildNoviceOrder({
      direction: body.direction,
      amount: body.amount,
      safetyNetPct: body.safetyNetPct,
      bid: snap.bid.toFixed(),
      ask: snap.ask.toFixed(),
      tickSize: inst.spec.tickSize,
      qtyStep: inst.spec.qtyStep,
      minQty: inst.spec.minQty,
      multiplier: inst.multiplier.toFixed(),
      fxRate: rate.rate.toFixed(),
      accountCcy: account.base_currency,
    });
    if (!built.ok) {
      if (built.reason === 'invalid')
        throw new BadRequestException({
          statusCode: 400,
          error: 'invalid_ticket',
          message: 'Check the amount and the safety net (0.5% to 10%).',
        });
      return { ok: false as const, reason: built.reason, minAmount: built.minAmount };
    }
    const order = PreviewOrderSchema.parse({
      symbol: inst.spec.symbol,
      side: built.side,
      type: 'market',
      qty: built.qty,
      stopLossPrice: built.stopLossPrice,
      tif: 'gtc',
    });
    const preview = await this.oms.preview(c.sub, c.roles, order);
    const loss = preview.preview?.lossIfStopHit ?? null;
    return {
      ok: true as const,
      order,
      refPrice: built.refPrice,
      amountUsed: built.amountUsed,
      minAmount: built.minAmount,
      safetyNetPct: body.safetyNetPct,
      currency: account.base_currency,
      preview,
      scenario: loss
        ? {
            /** If the safety net is hit: the preview's loss at the stop, fees included. */
            loss: loss.total,
            /** If the price moves the same distance the other way (about; fees deducted). */
            gain: scenarioGain(loss, account.base_currency),
          }
        : null,
    };
  }

  // ---- knowledge check (questionnaire engine, kind knowledge_check) ----

  async knowledgeCheck(userId: string) {
    const def = this.knowledgeDef();
    return { questionnaire: this.q.view(def), status: await this.knowledgeStatus(userId) };
  }

  async knowledgeAttempt(userId: string, body: AttemptRequest) {
    const def = this.knowledgeDef();
    if (body.questionnaireId !== def.id || body.version !== def.version)
      throw new ConflictException({
        error: 'questionnaire_version_changed',
        message: 'The check has changed. Reload it and answer again.',
        current: { id: def.id, version: def.version },
      });
    const g = this.q.grade(def, body.answers);
    if (g.missing.length || g.unknown.length)
      throw new BadRequestException({
        statusCode: 400,
        error: 'incomplete',
        message: 'Answer every question with one of its options.',
        missing: g.missing,
        unknown: g.unknown,
      });
    await this.q.ensureSynced();
    const out = await this.db.tx(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const last = await this.q.lastAttempt(userId, def.id, tx);
      if (last?.passed)
        throw new ConflictException({
          error: 'already_passed',
          message: 'You already passed this check.',
        });
      const until = this.q.cooldownUntil(def, last);
      if (until)
        throw new HttpException(
          {
            statusCode: 429,
            error: 'cooldown',
            message: `You can try again after ${until.toISOString()}.`,
            cooldownUntil: until.toISOString(),
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      const attempt = await this.q.record(tx, userId, def, g, new Date());
      const cooldownUntil = g.passed ? null : this.q.cooldownUntil(def, attempt);
      await this.audit.record(
        {
          actorId: userId,
          actorType: 'user',
          action: g.passed ? 'knowledge_check.passed' : 'knowledge_check.failed',
          entity: 'user',
          entityId: userId,
          payload: {
            questionnaireId: def.id,
            version: def.version,
            score: g.score,
            maxScore: g.maxScore,
            scorePct: g.scorePct,
            passMarkPct: g.passMarkPct,
            simulatedQuestions: def.simulated,
            attemptId: attempt.id,
            cooldownUntil: cooldownUntil?.toISOString() ?? null,
          },
        },
        tx,
      );
      return { cooldownUntil };
    });
    return {
      passed: g.passed,
      scorePct: g.scorePct,
      passMarkPct: g.passMarkPct,
      questionnaire: { id: def.id, version: def.version },
      cooldownUntil: out.cooldownUntil?.toISOString() ?? null,
      topicsToReview: g.passed ? [] : g.topicsToReview,
    };
  }
}
