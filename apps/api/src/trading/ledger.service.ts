import { Injectable } from '@nestjs/common';
import { cashBalance, dec, type Decimal, type Journal } from '@kora/domain';

import { DbService, type Queryable } from '../db/db.service';

/**
 * Posts balanced journals (ADR 0003 §ledger). The database refuses unbalanced journals with a
 * deferred trigger; `accounts.cash` is updated in the same transaction and reconciled later.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly db: DbService) {}

  async post(
    c: Queryable,
    accountId: string,
    j: Journal,
    ref: { type: string; id: string },
  ): Promise<Decimal> {
    if (j.lines.length === 0) return dec(0);
    const r = await c.query<{ id: string }>(
      'INSERT INTO ledger_journals (account_id, kind, currency, ref_type, ref_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [accountId, j.kind, j.currency, ref.type, ref.id],
    );
    const journalId = r.rows[0]!.id;
    await c.query(
      `INSERT INTO ledger_entries (journal_id, account_id, ledger_account, amount)
       SELECT $1, $2, a, m::numeric FROM unnest($3::text[], $4::text[]) AS u(a, m)`,
      [journalId, accountId, j.lines.map((l) => l.account), j.lines.map((l) => l.amount.toFixed())],
    );
    const cash = cashBalance(j.lines);
    if (!cash.isZero())
      await c.query(
        'UPDATE accounts SET cash = cash + $2::numeric, updated_at = now() WHERE id = $1',
        [accountId, cash.toFixed()],
      );
    return cash;
  }

  /** Ledger balances per ledger account (reconciliation and GET /accounts/me/ledger). */
  async balances(accountId: string, c?: Queryable): Promise<Map<string, Decimal>> {
    const q = c ?? this.db.pool;
    const r = await q.query<{ ledger_account: string; total: string }>(
      'SELECT ledger_account, sum(amount)::text AS total FROM ledger_entries WHERE account_id = $1 GROUP BY 1',
      [accountId],
    );
    return new Map(r.rows.map((x) => [x.ledger_account, dec(x.total)]));
  }

  async entries(accountId: string, limit: number, before?: string) {
    return this.db.query<{
      id: string;
      journal_id: string;
      kind: string;
      currency: string;
      ref_type: string | null;
      ref_id: string | null;
      ledger_account: string;
      amount: string;
      created_at: Date;
    }>(
      `SELECT e.id, e.journal_id, j.kind, j.currency, j.ref_type, j.ref_id, e.ledger_account, e.amount::text AS amount, e.created_at
       FROM ledger_entries e JOIN ledger_journals j ON j.id = e.journal_id
       WHERE e.account_id = $1 ${before ? 'AND e.created_at < $3::timestamptz' : ''}
       ORDER BY e.created_at DESC, e.id LIMIT $2`,
      before ? [accountId, limit, before] : [accountId, limit],
    );
  }
}
