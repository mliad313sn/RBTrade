import { TREND_X } from '@kora/domain';
import { describe, expect, it } from 'vitest';

import { paramsIn, sizeLabel, stopLabel, targetLabel } from '../../components/robots/BlockChips';
import { auditTag, auditText, fmtNum, fmtR, fmtRatioPct, fmtSigned, pauseLabel, robotsStatusLabel } from './format';

describe('robot formatting', () => {
  it('status-bar robots label comes from the robots list (IRTC R5-03)', () => {
    expect(robotsStatusLabel(null)).toBe('Robots: —');
    expect(robotsStatusLabel([])).toBe('Robots: none');
    expect(robotsStatusLabel([{ status: 'draft' }, { status: 'stopped' }])).toBe('Robots: none');
    expect(robotsStatusLabel([{ status: 'running' }, { status: 'running' }])).toBe('Robots: 2 running');
    expect(robotsStatusLabel([{ status: 'running' }, { status: 'paused' }])).toBe('Robots: 1 running · 1 paused');
    expect(robotsStatusLabel([{ status: 'paused' }])).toBe('Robots: 0 running · 1 paused');
  });

  it('always shows the sign (colour is never the only cue)', () => {
    expect(fmtSigned(1.234)).toBe('+1.23');
    expect(fmtSigned(-0.5, 1, '%')).toBe('−0.5%');
    expect(fmtNum(-2)).toBe('−2.00');
    expect(fmtNum(null)).toBe('—');
    expect(fmtRatioPct(0.184)).toBe('18.4%');
    expect(fmtR(0.31)).toBe('+0.31 R');
    expect(pauseLabel('heartbeat_lost')).toBe('Runner heartbeat lost');
    expect(pauseLabel('custom')).toBe('custom');
  });

  it('maps audit actions to the prototype tags and plain text', () => {
    expect(auditTag('order.new')).toBe('ORDER');
    expect(auditTag('robot.signal')).toBe('SIGNAL');
    expect(auditTag('strategy.version_created')).toBe('PARAM');
    expect(auditTag('robot.auto_paused')).toBe('RISK');
    expect(auditTag('robot.paused')).toBe('OVERRIDE');
    expect(
      auditText({
        action: 'strategy.version_created',
        payload: {
          version: 2,
          contentHash: 'abcdef123',
          reason: 'tighter',
          paramsChanged: [{ name: 'stop_atr', from: '1.5', to: '1.4' }],
        },
      }),
    ).toBe('v2 #abcdef (stop_atr 1.5 → 1.4) · tighter');
    expect(auditText({ action: 'robot.auto_paused', payload: { reason: 'max_drawdown' } })).toBe(
      'Paused · Max drawdown limit',
    );
  });

  it('labels Trend-X like the prototype chips', () => {
    expect(stopLabel(TREND_X)).toBe('Stop 1.5 × ATR(14)');
    expect(targetLabel(TREND_X)).toBe('Target 3 × ATR');
    expect(sizeLabel(TREND_X)).toBe('Risk 0.75% equity / trade · max 3 open');
    expect(paramsIn(TREND_X.exit.trailing).sort()).toEqual(['stop_atr', 'trail_r']);
  });
});
