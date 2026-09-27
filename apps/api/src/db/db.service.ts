import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { APP_CONFIG, type AppConfig } from '../config/config';

export type Queryable = Pick<PoolClient, 'query'>;

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      // Goal 10 load finding: 10 connections queued the order path at 100 orders/s (pool waits of
      // 100–200 ms). Size per replica with KORA_DB_POOL_MAX (keep replicas × max under Postgres
      // max_connections or put PgBouncer in front).
      max: Math.max(2, Math.min(200, Number(process.env.KORA_DB_POOL_MAX ?? 20) || 20)),
      application_name: 'kora-api',
      statement_timeout: 10_000,
    });
  }

  async query<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query<T>(sql, params);
    return res.rows;
  }

  /** Runs fn in a READ COMMITTED transaction. */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
