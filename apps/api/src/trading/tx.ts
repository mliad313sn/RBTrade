import type { PoolClient } from 'pg';
import type { ActorType } from '@kora/domain';

import type { AuditRecordInput } from '../audit/audit.service';
import { ChangeSet, type AccountRow } from './trading.types';

export interface Actor {
  type: ActorType;
  id: string;
}

export const ENGINE_ACTOR: Actor = { type: 'system', id: 'paper-engine' };

/**
 * One account-scoped trading transaction: the account row is locked (`FOR UPDATE`), audit events
 * are collected and appended in one batch before commit, and the change set is published after.
 */
export class TradingTx {
  readonly audits: AuditRecordInput[] = [];
  readonly changes = new ChangeSet();

  constructor(
    readonly c: PoolClient,
    public account: AccountRow,
    readonly now: number,
  ) {}

  audit(
    actor: Actor,
    action: string,
    entity: string,
    entityId: string | null,
    payload: AuditRecordInput['payload'],
  ): void {
    this.audits.push({
      actorId: actor.id,
      actorType: actor.type,
      action,
      entity,
      entityId,
      payload: payload ?? {},
    });
  }
}
