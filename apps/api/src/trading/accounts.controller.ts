import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AUDIT_READ_ALL_ROLES, dec, hasAnyRole, SYMBOL_RE } from '@kora/domain';
import { z } from 'zod';

import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { DbService } from '../db/db.service';
import {
  AccountSettingsSchema,
  AccountsService,
  type AccountSettingsPatch,
} from './accounts.service';
import { LedgerService } from './ledger.service';
import { OmsService } from './oms.service';
import { orderThrottle } from './orders.controller';
import { ReconciliationService } from './reconciliation.service';
import { toFillDto, type FillRow } from './trading.types';

const Page = z
  .object({
    limit: z.coerce.number().int().min(1).max(5000).optional(),
    before: z.iso.datetime({ offset: true }).optional(),
    symbol: z.string().regex(SYMBOL_RE).optional(),
  })
  .strict();

@ApiTags('accounts')
@Controller()
export class AccountsController {
  constructor(
    private readonly db: DbService,
    private readonly accounts: AccountsService,
    private readonly ledger: LedgerService,
    private readonly oms: OmsService,
    private readonly recon: ReconciliationService,
  ) {}

  @Get('accounts/me')
  @ApiOperation({
    summary:
      'Paper account: cash, equity, day P&L, margin used/free, leverage, loss-limit usage, halt state (base currency, SIMULATED).',
  })
  async me(@CurrentPrincipal() p: Principal) {
    return this.accounts.view(await this.accounts.ensure(p.sub));
  }

  @Put('accounts/me/settings')
  @ApiOperation({
    summary:
      'Confirmation thresholds, tighter risk limits, and the base currency (only before any activity). Audited.',
  })
  @ApiBody({ schema: openApiSchema(AccountSettingsSchema) })
  async settings(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(AccountSettingsSchema)) body: AccountSettingsPatch,
  ) {
    return this.accounts.view(await this.accounts.updateSettings(p.sub, body));
  }

  @Get('accounts/me/ledger')
  @ApiOperation({
    summary: 'Double-entry ledger lines (newest first) and balances per ledger account.',
  })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'before', required: false })
  async ledgerLines(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodValidationPipe(Page)) q: z.infer<typeof Page>,
  ) {
    const a = await this.accounts.ensure(p.sub);
    const [entries, balances] = await Promise.all([
      this.ledger.entries(a.id, q.limit ?? 200, q.before),
      this.ledger.balances(a.id),
    ]);
    let total = dec(0);
    for (const v of balances.values()) total = total.add(v);
    return {
      accountId: a.id,
      currency: a.base_currency,
      balances: Object.fromEntries([...balances].map(([k, v]) => [k, v.toFixed()])),
      trialBalance: total.toFixed(),
      entries: entries.map((e) => ({ ...e, created_at: e.created_at.toISOString() })),
    };
  }

  @Get('positions')
  @ApiOperation({
    summary:
      'Open positions with mark (exit side), unrealised P&L, notional and margin in base currency.',
  })
  async positions(@CurrentPrincipal() p: Principal) {
    const a = await this.accounts.ensure(p.sub);
    return {
      accountId: a.id,
      currency: a.base_currency,
      positions: await this.accounts.positionsView(a),
    };
  }

  @Post('positions/:symbol/close')
  @HttpCode(201)
  @Throttle(orderThrottle())
  @ApiOperation({
    summary: 'Close a position at market (reduce-only market order through the normal OMS path).',
  })
  async close(@CurrentPrincipal() p: Principal, @Param('symbol') symbol: string) {
    if (!SYMBOL_RE.test(symbol))
      throw new NotFoundException({ error: 'not_found', message: 'Unknown symbol' });
    const a = await this.accounts.ensure(p.sub);
    const pos = (await this.accounts.positions(a.id)).find((x) => x.symbol === symbol);
    if (!pos)
      throw new NotFoundException({ error: 'no_position', message: `No open ${symbol} position.` });
    const qty = dec(pos.qty);
    return this.oms.submit(
      { userId: p.sub, roles: p.roles, actor: { type: 'user', id: p.sub }, source: 'manual' },
      {
        clientOrderId: `close-${randomUUID()}`,
        symbol,
        side: qty.isPositive() ? 'sell' : 'buy',
        type: 'market',
        qty: qty.abs().toFixed(),
        tif: 'gtc',
        reduceOnly: true,
        postOnly: false,
        source: 'manual',
      },
    );
  }

  @Get('fills')
  @ApiOperation({
    summary:
      'Fills with quote at decision, fill price, slippage, fees and FX conversion (newest first).',
  })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'before', required: false })
  @ApiQuery({ name: 'symbol', required: false })
  async fills(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodValidationPipe(Page)) q: z.infer<typeof Page>,
  ) {
    const a = await this.accounts.ensure(p.sub);
    const params: unknown[] = [a.id, q.limit ?? 200];
    let where = 'account_id = $1';
    if (q.before) {
      params.push(q.before);
      where += ` AND ts < $${params.length}::timestamptz`;
    }
    if (q.symbol) {
      params.push(q.symbol);
      where += ` AND symbol = $${params.length}`;
    }
    const rows = await this.db.query<FillRow>(
      `SELECT * FROM fills WHERE ${where} ORDER BY ts DESC, id LIMIT $2`,
      params,
    );
    return { accountId: a.id, currency: a.base_currency, fills: rows.map(toFillDto) };
  }

  @Get('alerts')
  @ApiOperation({
    summary:
      'Alerts (reconciliation mismatches). Risk officers and admins see all; others their own account.',
  })
  async alerts(@CurrentPrincipal() p: Principal) {
    if (hasAnyRole(p.roles, AUDIT_READ_ALL_ROLES)) {
      return {
        alerts: await this.db.query('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 200'),
      };
    }
    const a = await this.accounts.ensure(p.sub);
    return {
      alerts: await this.db.query(
        'SELECT * FROM alerts WHERE account_id = $1 ORDER BY created_at DESC LIMIT 200',
        [a.id],
      ),
    };
  }

  @Post('reconciliation/run')
  @HttpCode(200)
  @Roles('risk_officer', 'admin', 'trader', 'quant')
  @ApiOperation({
    summary:
      'Run reconciliation now (engine positions vs ledger replay, cash vs ledger). Risk officers/admins: all accounts; others: own account.',
  })
  async reconcile(@CurrentPrincipal() p: Principal) {
    if (hasAnyRole(p.roles, AUDIT_READ_ALL_ROLES)) return this.recon.run('manual', p.sub);
    const a = await this.accounts.ensure(p.sub);
    return this.recon.run('manual', p.sub, a.id);
  }
}
