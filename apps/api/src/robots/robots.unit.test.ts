import type { ExecutionContext } from '@nestjs/common';
import { DEFAULT_ROBOT_LIMITS } from '@kora/domain';
import { describe, expect, it } from 'vitest';

import { maxBars } from '../strategies/research-data.service';
import { promotionThresholds } from './promotion.service';
import { supervisorMs } from './robot-supervisor.service';
import { heartbeatMs, limitsHash } from './robots.service';
import { serviceToken, ServiceTokenGuard } from './service-token.guard';

const ctx = (header?: string) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ header: () => header }) }) }) as unknown as ExecutionContext;

describe('robots config and guards', () => {
  it('limits hash is stable across key order and changes with any limit', () => {
    const a = limitsHash(DEFAULT_ROBOT_LIMITS);
    const reordered = Object.fromEntries(Object.entries(DEFAULT_ROBOT_LIMITS).reverse()) as typeof DEFAULT_ROBOT_LIMITS;
    expect(limitsHash(reordered)).toBe(a);
    expect(limitsHash({ ...DEFAULT_ROBOT_LIMITS, maxDrawdownPct: 9 })).not.toBe(a);
  });

  it('reads heartbeat, supervisor, bar and promotion settings from env with safe defaults', () => {
    expect(heartbeatMs({})).toBe(5000);
    expect(heartbeatMs({ KORA_ROBOT_HEARTBEAT_MS: '250' })).toBe(250);
    expect(heartbeatMs({ KORA_ROBOT_HEARTBEAT_MS: 'x' })).toBe(5000);
    expect(supervisorMs({})).toBe(1000);
    expect(supervisorMs({ KORA_ROBOT_SUPERVISOR_MS: '0' })).toBe(0);
    expect(maxBars({})).toBe(20_000);
    expect(maxBars({ KORA_BT_MAX_BARS: '999999' })).toBe(60_000);
    expect(promotionThresholds({})).toEqual({ minOosSharpe: 0.8, minOosTrades: 100, minPaperDays: 30, maxTrackingErrorPct: 1 });
    expect(promotionThresholds({ KORA_PROMOTE_MIN_OOS_SHARPE: '1.2' }).minOosSharpe).toBe(1.2);
  });

  it('service token: required length, refused when unset, constant-time match', () => {
    expect(serviceToken({ KORA_SERVICE_TOKEN: 'short' })).toBeNull();
    const token = 'a'.repeat(40);
    const g = new ServiceTokenGuard();
    const prev = process.env.KORA_SERVICE_TOKEN;
    try {
      delete process.env.KORA_SERVICE_TOKEN;
      expect(() => g.canActivate(ctx(token))).toThrow(/not configured/);
      process.env.KORA_SERVICE_TOKEN = token;
      expect(g.canActivate(ctx(token))).toBe(true);
      expect(() => g.canActivate(ctx('b'.repeat(40)))).toThrow(/Invalid service token/);
      expect(() => g.canActivate(ctx(undefined))).toThrow(/Invalid service token/);
    } finally {
      if (prev === undefined) delete process.env.KORA_SERVICE_TOKEN;
      else process.env.KORA_SERVICE_TOKEN = prev;
    }
  });
});
