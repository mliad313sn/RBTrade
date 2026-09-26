import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AUDIT_READ_ALL_ROLES,
  canonicalStrategyJson,
  hasAnyRole,
  paramsDiff,
  shortHash,
  validateStrategy,
  warmupBars,
  type Role,
  type StrategyDefinition,
  type StrategyIssue,
} from '@kora/domain';
import { strategyContentHash } from '@kora/domain/server';
import { BadRequestException } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { DbService, type Queryable } from '../db/db.service';
import { TradingRegistryService } from '../trading/trading-registry.service';

export interface StrategyRow {
  id: string;
  owner_id: string;
  name: string;
  latest_version: number;
  created_at: Date;
  updated_at: Date;
}

export interface VersionRow {
  id: string;
  strategy_id: string;
  version: number;
  content_hash: string;
  schema_version: number;
  definition: StrategyDefinition;
  author_id: string;
  reason: string;
  parent_version_id: string | null;
  created_at: Date;
}

export function versionDto(v: VersionRow) {
  return {
    id: v.id,
    strategyId: v.strategy_id,
    version: v.version,
    contentHash: v.content_hash,
    shortHash: shortHash(v.content_hash),
    schemaVersion: v.schema_version,
    definition: v.definition,
    authorId: v.author_id,
    reason: v.reason,
    parentVersionId: v.parent_version_id,
    createdAt: v.created_at.toISOString(),
  };
}

function strategyDto(s: StrategyRow, latest?: VersionRow) {
  return {
    id: s.id,
    ownerId: s.owner_id,
    name: s.name,
    latestVersion: s.latest_version,
    createdAt: s.created_at.toISOString(),
    updatedAt: s.updated_at.toISOString(),
    ...(latest ? { latest: versionDto(latest) } : {}),
  };
}

/**
 * Strategies and their immutable, content-hashed versions (goal 06 §1). Every new version records
 * its author and reason and is audited with the parameter diff.
 */
@Injectable()
export class StrategiesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly registry: TradingRegistryService,
  ) {}

  /** Schema + semantic validation, registry checks for the instruments, and the content hash. */
  async validate(input: unknown) {
    const v = validateStrategy(input);
    const issues: StrategyIssue[] = [...v.issues];
    if (v.definition) {
      for (const [i, sym] of v.definition.universe.symbols.entries()) {
        const inst = await this.registry.find(sym);
        if (!inst)
          issues.push({
            path: `universe.symbols.${i}`,
            message: `${sym} is not in the instrument registry.`,
            severity: 'error',
          });
        else if (inst.spec.status !== 'active')
          issues.push({
            path: `universe.symbols.${i}`,
            message: `${sym} is ${inst.spec.status}: robots cannot trade it.`,
            severity: 'error',
          });
      }
    }
    const valid = !!v.definition && !issues.some((i) => i.severity === 'error');
    const hash = v.definition ? strategyContentHash(v.definition) : null;
    return {
      valid,
      issues,
      contentHash: hash,
      shortHash: hash ? shortHash(hash) : null,
      warmupBars: v.definition ? warmupBars(v.definition) : null,
      definition: v.definition,
    };
  }

  private async mustBeValid(
    input: unknown,
  ): Promise<{ definition: StrategyDefinition; hash: string }> {
    const v = await this.validate(input);
    if (!v.valid || !v.definition || !v.contentHash)
      throw new BadRequestException({
        statusCode: 400,
        error: 'invalid_strategy',
        message:
          v.issues.find((i) => i.severity === 'error')?.message ?? 'The strategy is not valid.',
        issues: v.issues,
      });
    return { definition: v.definition, hash: v.contentHash };
  }

  async create(userId: string, input: { definition: unknown; reason: string }) {
    const { definition, hash } = await this.mustBeValid(input.definition);
    return this.db.tx(async (c) => {
      const s = (
        await c.query<StrategyRow>(
          'INSERT INTO strategies (owner_id, name) VALUES ($1, $2) RETURNING *',
          [userId, definition.name],
        )
      ).rows[0]!;
      const v = (
        await c.query<VersionRow>(
          `INSERT INTO strategy_versions (strategy_id, version, content_hash, schema_version, definition, author_id, reason)
           VALUES ($1, 1, $2, $3, $4, $5, $6) RETURNING *`,
          [s.id, hash, definition.schemaVersion, JSON.stringify(definition), userId, input.reason],
        )
      ).rows[0]!;
      await this.audit.recordMany(
        [
          {
            actorId: userId,
            actorType: 'user',
            action: 'strategy.created',
            entity: 'strategy',
            entityId: s.id,
            payload: { name: s.name },
          },
          {
            actorId: userId,
            actorType: 'user',
            action: 'strategy.version_created',
            entity: 'strategy',
            entityId: s.id,
            payload: {
              strategyId: s.id,
              versionId: v.id,
              version: 1,
              contentHash: hash,
              previousHash: null,
              reason: input.reason,
              paramsChanged: diffPayload(null, definition),
            },
          },
        ],
        c,
      );
      return { ...strategyDto(s, v), created: true };
    });
  }

  async list(userId: string) {
    const rows = await this.db.query<StrategyRow & { v: VersionRow }>(
      `SELECT s.*, row_to_json(v.*) AS v FROM strategies s
       JOIN strategy_versions v ON v.strategy_id = s.id AND v.version = s.latest_version
       WHERE s.owner_id = $1 ORDER BY s.updated_at DESC LIMIT 200`,
      [userId],
    );
    return {
      strategies: rows.map((r) => strategyDto(r, { ...r.v, created_at: new Date(r.v.created_at) })),
    };
  }

  async strategy(
    userId: string,
    roles: Role[],
    id: string,
    c: Queryable = this.db.pool,
  ): Promise<StrategyRow> {
    const r = await c.query<StrategyRow>('SELECT * FROM strategies WHERE id = $1', [id]);
    const s = r.rows[0];
    if (!s || (s.owner_id !== userId && !hasAnyRole(roles, AUDIT_READ_ALL_ROLES)))
      throw new NotFoundException({ error: 'not_found', message: 'Strategy not found.' });
    return s;
  }

  async get(userId: string, roles: Role[], id: string) {
    const s = await this.strategy(userId, roles, id);
    const versions = await this.db.query<VersionRow>(
      'SELECT * FROM strategy_versions WHERE strategy_id = $1 ORDER BY version DESC',
      [id],
    );
    const trials = await this.db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM strategy_trials WHERE strategy_id = $1',
      [id],
    );
    return {
      ...strategyDto(s, versions[0]),
      versions: versions.map(versionDto),
      trials: Number(trials[0]!.n),
    };
  }

  /** A version the caller may read (owner, or risk officer/admin for reviews). */
  async version(
    userId: string,
    roles: Role[],
    versionId: string,
  ): Promise<{ version: VersionRow; strategy: StrategyRow }> {
    const r = await this.db.query<VersionRow>('SELECT * FROM strategy_versions WHERE id = $1', [
      versionId,
    ]);
    if (!r[0])
      throw new NotFoundException({ error: 'not_found', message: 'Strategy version not found.' });
    const strategy = await this.strategy(userId, roles, r[0].strategy_id);
    return { version: r[0], strategy };
  }

  async newVersion(
    userId: string,
    roles: Role[],
    strategyId: string,
    input: { definition: unknown; reason: string; baseVersionId: string },
  ) {
    const { definition, hash } = await this.mustBeValid(input.definition);
    return this.db.tx(async (c) => {
      const s = (
        await c.query<StrategyRow>('SELECT * FROM strategies WHERE id = $1 FOR UPDATE', [
          strategyId,
        ])
      ).rows[0];
      if (!s || s.owner_id !== userId) {
        if (s && hasAnyRole(roles, AUDIT_READ_ALL_ROLES))
          throw new ForbiddenException({
            error: 'forbidden',
            message: 'Only the owner can change a strategy.',
          });
        throw new NotFoundException({ error: 'not_found', message: 'Strategy not found.' });
      }
      const latest = (
        await c.query<VersionRow>(
          'SELECT * FROM strategy_versions WHERE strategy_id = $1 AND version = $2',
          [strategyId, s.latest_version],
        )
      ).rows[0]!;
      if (latest.id !== input.baseVersionId)
        throw new ConflictException({
          error: 'stale_version',
          message: `The strategy changed since you opened it (now v${latest.version}). Reload and apply your edit again.`,
          latestVersionId: latest.id,
        });
      // nosemgrep: ajinabraham.njsscan.crypto.timing_attack_node.node_timing_attack -- compares public content hashes, not secrets, reviewed goal 10
      if (latest.content_hash === hash) return { ...strategyDto(s, latest), created: false };
      const next = s.latest_version + 1;
      const v = (
        await c.query<VersionRow>(
          `INSERT INTO strategy_versions (strategy_id, version, content_hash, schema_version, definition, author_id, reason, parent_version_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [
            strategyId,
            next,
            hash,
            definition.schemaVersion,
            JSON.stringify(definition),
            userId,
            input.reason,
            latest.id,
          ],
        )
      ).rows[0]!;
      const updated = (
        await c.query<StrategyRow>(
          'UPDATE strategies SET latest_version = $2, name = $3, updated_at = now() WHERE id = $1 RETURNING *',
          [strategyId, next, definition.name],
        )
      ).rows[0]!;
      await this.audit.record(
        {
          actorId: userId,
          actorType: 'user',
          action: 'strategy.version_created',
          entity: 'strategy',
          entityId: strategyId,
          payload: {
            strategyId,
            versionId: v.id,
            version: next,
            contentHash: hash,
            previousHash: latest.content_hash,
            reason: input.reason,
            paramsChanged: diffPayload(latest.definition, definition),
            logicChanged: logicChanged(latest.definition, definition),
          },
        },
        c,
      );
      return { ...strategyDto(updated, v), created: true };
    });
  }
}

/** Audit payloads take strings for decimals. */
function diffPayload(prev: StrategyDefinition | null, next: StrategyDefinition) {
  return paramsDiff(prev, next).map((d) => ({
    name: d.name,
    from: d.from === null ? null : String(d.from),
    to: d.to === null ? null : String(d.to),
  }));
}

function logicChanged(prev: StrategyDefinition, next: StrategyDefinition): boolean {
  const strip = (d: StrategyDefinition) =>
    canonicalStrategyJson({
      ...d,
      params: Object.keys(d.params).sort(),
      name: undefined,
      description: undefined,
    });
  return strip(prev) !== strip(next);
}
