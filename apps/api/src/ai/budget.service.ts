import { Injectable } from '@nestjs/common';

import { RedisService } from '../db/redis.service';
import type { AiConfig } from './core/config';

export type BudgetVerdict =
  | { ok: true; userUsed: number; orgUsed: number; reserved: number }
  | {
      ok: false;
      scope: 'user_budget' | 'org_budget' | 'rate';
      message: string;
      retryAfterSeconds: number;
    };

const prefix = () => process.env.KORA_AI_REDIS_PREFIX ?? 'kora:ai:';

function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function secondsToMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Math.max(
    1,
    Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000),
  );
}

/**
 * Per-user and per-org daily token budgets and a per-user request rate limit (Redis, UTC day
 * windows). Exceeding one yields a friendly message, never an error page.
 */
@Injectable()
export class BudgetService {
  constructor(private readonly redis: RedisService) {}

  private async client() {
    const c = this.redis.client;
    if (c.status === 'wait' || c.status === 'end') await c.connect().catch(() => undefined);
    return c;
  }

  private keys(userId: string, orgId: string, now = Date.now()) {
    const day = utcDay(now);
    return {
      user: `${prefix()}tokens:user:${userId}:${day}`,
      org: `${prefix()}tokens:org:${orgId}:${day}`,
      rate: `${prefix()}rate:user:${userId}:${Math.floor(now / 60_000)}`,
      pipeline: `${prefix()}tokens:pipeline:${orgId}:${day}`,
    };
  }

  async check(userId: string, cfg: AiConfig): Promise<BudgetVerdict> {
    const c = await this.client();
    const k = this.keys(userId, cfg.orgId);
    const count = await c.incr(k.rate);
    if (count === 1) await c.expire(k.rate, 70);
    if (count > cfg.ratePerMin) {
      return {
        ok: false,
        scope: 'rate',
        message: `You're asking the copilot faster than it can keep up (limit ${cfg.ratePerMin} questions a minute). Please wait a moment and try again.`,
        retryAfterSeconds: 60 - Math.floor((Date.now() % 60_000) / 1000),
      };
    }
    // IRTC R4-20: reserve one answer's worth of tokens up front, so parallel requests see each
    // other; a request is allowed while the budget was not yet spent before its own reservation.
    const reserved = cfg.maxTokens;
    const ttl = secondsToMidnight() + 3600;
    const res = await c
      .multi()
      .incrby(k.user, reserved)
      .expire(k.user, ttl)
      .incrby(k.org, reserved)
      .expire(k.org, ttl)
      .exec();
    const userUsed = Number(res?.[0]?.[1] ?? reserved) - reserved;
    const orgUsed = Number(res?.[2]?.[1] ?? reserved) - reserved;
    const deny = userUsed >= cfg.userDailyTokens || orgUsed >= cfg.orgDailyTokens;
    if (deny) await this.release(userId, cfg, reserved);
    if (userUsed >= cfg.userDailyTokens) {
      return {
        ok: false,
        scope: 'user_budget',
        message:
          "You've used today's copilot allowance. It resets at midnight UTC. Charts, previews and trading keep working as normal.",
        retryAfterSeconds: secondsToMidnight(),
      };
    }
    if (orgUsed >= cfg.orgDailyTokens) {
      return {
        ok: false,
        scope: 'org_budget',
        message:
          "The copilot has reached today's allowance for your organisation. It resets at midnight UTC. Everything else keeps working.",
        retryAfterSeconds: secondsToMidnight(),
      };
    }
    return { ok: true, userUsed, orgUsed, reserved };
  }

  /**
   * Adds used tokens, settling a reservation made by `check` (the difference can be negative);
   * returns the org total for the gauge.
   */
  async add(
    userId: string,
    cfg: AiConfig,
    tokens: number,
    reserved = 0,
  ): Promise<{ userUsed: number; orgUsed: number }> {
    const c = await this.client();
    const k = this.keys(userId, cfg.orgId);
    const ttl = secondsToMidnight() + 3600;
    const delta = tokens - reserved;
    const res = await c
      .multi()
      .incrby(k.user, delta)
      .expire(k.user, ttl)
      .incrby(k.org, delta)
      .expire(k.org, ttl)
      .exec();
    return { userUsed: Number(res?.[0]?.[1] ?? 0), orgUsed: Number(res?.[2]?.[1] ?? 0) };
  }

  /** Gives back a reservation that was not used (cache hit, provider error, denial). */
  async release(userId: string, cfg: AiConfig, reserved: number): Promise<void> {
    if (reserved > 0) await this.add(userId, cfg, 0, reserved);
  }

  /** IRTC R4-20: the news pipeline's own daily budget (it never spends the copilot org budget). */
  async pipelineUsage(cfg: AiConfig): Promise<{ used: number; budget: number }> {
    const c = await this.client();
    const [v] = await c.mget(this.keys('pipeline', cfg.orgId).pipeline);
    return { used: Number(v ?? 0), budget: cfg.pipelineDailyTokens };
  }

  async addPipeline(cfg: AiConfig, tokens: number): Promise<void> {
    const c = await this.client();
    const key = this.keys('pipeline', cfg.orgId).pipeline;
    await c
      .multi()
      .incrby(key, tokens)
      .expire(key, secondsToMidnight() + 3600)
      .exec();
  }

  async usage(
    userId: string,
    cfg: AiConfig,
  ): Promise<{
    userUsed: number;
    orgUsed: number;
    userBudget: number;
    orgBudget: number;
    resetsInSeconds: number;
  }> {
    const c = await this.client();
    const k = this.keys(userId, cfg.orgId);
    const [u, o] = await c.mget(k.user, k.org);
    return {
      userUsed: Number(u ?? 0),
      orgUsed: Number(o ?? 0),
      userBudget: cfg.userDailyTokens,
      orgBudget: cfg.orgDailyTokens,
      resetsInSeconds: secondsToMidnight(),
    };
  }
}

/** Response cache for identical grounded requests (key = model + prompt hash). */
@Injectable()
export class ResponseCacheService {
  constructor(private readonly redis: RedisService) {}

  private async client() {
    const c = this.redis.client;
    if (c.status === 'wait' || c.status === 'end') await c.connect().catch(() => undefined);
    return c;
  }

  async get<T>(modelId: string, promptHash: string): Promise<T | null> {
    const raw = await (await this.client()).get(`${prefix()}cache:${modelId}:${promptHash}`);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async set(
    modelId: string,
    promptHash: string,
    value: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    if (ttlSeconds <= 0) return;
    await (
      await this.client()
    ).set(`${prefix()}cache:${modelId}:${promptHash}`, JSON.stringify(value), 'EX', ttlSeconds);
  }
}
