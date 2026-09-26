import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { dec, type Side } from '@kora/domain';

import { AuditService } from '../audit/audit.service';
import { DbService, type Queryable } from '../db/db.service';
import { PaperBrokerAdapter } from './broker/broker';
import { TRADING_CONFIG, type TradingConfig } from './trading-config';
import { TradingRegistryService } from './trading-registry.service';

export interface Mismatch {
  accountId: string;
  kind: 'position_qty' | 'position_avg_price' | 'cash' | 'ledger_unbalanced' | 'orphan_position';
  symbol?: string;
  engine: string;
  broker: string;
}

/**
 * Reconciliation (goal 03 §7): every 60 s and on demand, engine positions are compared with the
 * broker's view (paper: an independent replay of the fills) and `accounts.cash` with the ledger.
 * Any mismatch raises a critical alert, an audit event and an error log.
 */
@Injectable()
export class ReconciliationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Reconciliation');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  readonly broker: PaperBrokerAdapter;

  constructor(
    @Inject(TRADING_CONFIG) private readonly cfg: TradingConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly registry: TradingRegistryService,
  ) {
    this.broker = new PaperBrokerAdapter({
      fillsFor: async (accountId, snapshot) => {
        const q = (snapshot as Queryable | undefined) ?? this.db.pool;
        const rows = (
          await q.query<{ symbol: string; side: Side; qty: string; price: string }>(
            'SELECT symbol, side, qty::text AS qty, price::text AS price FROM fills WHERE account_id = $1 ORDER BY ts, id',
            [accountId],
          )
        ).rows;
        const out = [];
        for (const r of rows)
          out.push({ ...r, multiplier: (await this.registry.get(r.symbol)).multiplier });
        return out;
      },
    });
  }

  onApplicationBootstrap(): void {
    if (this.cfg.reconciliationIntervalMs > 0) {
      this.timer = setInterval(
        () => void this.run('schedule').catch((e: Error) => this.log.warn(e.message)),
        this.cfg.reconciliationIntervalMs,
      );
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Compares one account inside a REPEATABLE READ snapshot, so concurrent fills cannot skew it. */
  async checkAccount(accountId: string): Promise<Mismatch[]> {
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const r = await this.compare(client, accountId);
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  private async compare(q: Queryable, accountId: string): Promise<Mismatch[]> {
    const out: Mismatch[] = [];
    const engine = (
      await q.query<{ symbol: string; qty: string; avg_price: string }>(
        'SELECT symbol, qty::text AS qty, avg_price::text AS avg_price FROM positions WHERE account_id = $1',
        [accountId],
      )
    ).rows;
    const broker = new Map((await this.broker.positions(accountId, q)).map((p) => [p.symbol, p]));
    for (const e of engine) {
      const b = broker.get(e.symbol);
      const bq = b?.qty ?? dec(0);
      if (!dec(e.qty).eq(bq))
        out.push({
          accountId,
          kind: 'position_qty',
          symbol: e.symbol,
          engine: e.qty,
          broker: bq.toFixed(),
        });
      else if (!bq.isZero() && dec(e.avg_price).sub(b!.avgPrice).abs().gt('1e-12')) {
        out.push({
          accountId,
          kind: 'position_avg_price',
          symbol: e.symbol,
          engine: e.avg_price,
          broker: b!.avgPrice.toFixed(),
        });
      }
      broker.delete(e.symbol);
    }
    for (const [symbol, b] of broker)
      if (!b.qty.isZero())
        out.push({
          accountId,
          kind: 'orphan_position',
          symbol,
          engine: '0',
          broker: b.qty.toFixed(),
        });
    const cash = (
      await q.query<{ cached: string; ledger: string | null; total: string | null }>(
        `SELECT a.cash::text AS cached,
         (SELECT sum(amount)::text FROM ledger_entries WHERE account_id = a.id AND ledger_account = 'cash') AS ledger,
         (SELECT sum(amount)::text FROM ledger_entries WHERE account_id = a.id) AS total
       FROM accounts a WHERE a.id = $1`,
        [accountId],
      )
    ).rows;
    const c = cash[0];
    if (c) {
      if (!dec(c.cached).eq(dec(c.ledger ?? '0')))
        out.push({ accountId, kind: 'cash', engine: c.cached, broker: c.ledger ?? '0' });
      if (!dec(c.total ?? '0').isZero())
        out.push({ accountId, kind: 'ledger_unbalanced', engine: c.total ?? '0', broker: '0' });
    }
    return out;
  }

  /** Runs over every account (or one). Returns the run summary. */
  async run(
    trigger: 'schedule' | 'manual',
    requestedBy: string | null = null,
    onlyAccount?: string,
  ) {
    if (this.running && trigger === 'schedule') return null;
    this.running = true;
    const started = new Date();
    try {
      const accounts = onlyAccount
        ? [{ id: onlyAccount }]
        : await this.db.query<{ id: string }>('SELECT id FROM accounts ORDER BY created_at');
      const mismatches: Mismatch[] = [];
      for (const a of accounts) mismatches.push(...(await this.checkAccount(a.id)));
      const finished = new Date();
      const run = await this.db.query<{ id: string }>(
        `INSERT INTO reconciliation_runs (trigger, requested_by, started_at, finished_at, accounts_checked, mismatches, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id`,
        [
          trigger,
          requestedBy,
          started,
          finished,
          accounts.length,
          mismatches.length,
          JSON.stringify(mismatches),
        ],
      );
      const runId = run[0]!.id;
      const byAccount = new Map<string, Mismatch[]>();
      for (const m of mismatches)
        byAccount.set(m.accountId, [...(byAccount.get(m.accountId) ?? []), m]);
      for (const [accountId, list] of byAccount) {
        this.log.error(
          `reconciliation mismatch on account ${accountId}: ${list.map((m) => `${m.kind}${m.symbol ? `(${m.symbol})` : ''}`).join(', ')}`,
        );
        await this.db.tx(async (c) => {
          await c.query(
            `INSERT INTO alerts (severity, kind, account_id, message, details) VALUES ('critical', 'reconciliation.mismatch', $1, $2, $3::jsonb)`,
            [
              accountId,
              `Reconciliation found ${list.length} mismatch(es) between engine positions/cash and the ledger replay.`,
              JSON.stringify({ runId, mismatches: list }),
            ],
          );
          await this.audit.record(
            {
              actorId: 'reconciliation',
              actorType: 'system',
              action: 'reconciliation.mismatch',
              entity: 'account',
              entityId: accountId,
              payload: {
                runId,
                severity: 'critical',
                mismatches: list.map((m) => ({
                  kind: m.kind,
                  symbol: m.symbol ?? null,
                  engine: m.engine,
                  broker: m.broker,
                })),
              },
            },
            c,
          );
        });
      }
      if (trigger === 'manual') {
        await this.audit.record({
          actorId: requestedBy ?? 'unknown',
          actorType: 'user',
          action: 'reconciliation.run',
          entity: 'reconciliation',
          entityId: runId,
          payload: { accountsChecked: accounts.length, mismatches: mismatches.length },
        });
      }
      return {
        runId,
        trigger,
        startedAt: started.toISOString(),
        finishedAt: finished.toISOString(),
        accountsChecked: accounts.length,
        mismatches,
      };
    } finally {
      this.running = false;
    }
  }
}
