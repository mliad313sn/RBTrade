import { describe, expect, it } from 'vitest';

import { counterpartPath, isNoviceRoute, isProRoute, landingPath } from './modes';
import { checkRoute, isPublicPath } from './route-rules';

describe('route rules', () => {
  it('blocks novices from the robot builder routes', () => {
    expect(checkRoute('/robots', ['novice'])).toMatchObject({
      allow: false,
      feature: 'Robot builder',
    });
    expect(checkRoute('/robots/builder', ['novice'])).toMatchObject({ allow: false });
    expect(checkRoute('/robots/builder/new', ['novice'])).toMatchObject({ allow: false });
    expect(checkRoute('/robotsx', ['novice'])).toEqual({ allow: true });
  });
  it('allows builder roles and admin-only routes for admin', () => {
    for (const r of ['trader', 'quant', 'admin'] as const)
      expect(checkRoute('/robots/builder', [r])).toEqual({ allow: true });
    expect(checkRoute('/robots/builder', ['risk_officer'])).toMatchObject({ allow: false });
    expect(checkRoute('/admin/users', ['trader'])).toMatchObject({
      allow: false,
      requiredRoles: ['admin'],
    });
    expect(checkRoute('/admin/users', ['admin'])).toEqual({ allow: true });
    expect(checkRoute('/terminal', ['novice'])).toEqual({ allow: true });
  });
  it('goal 09: the risk console is 2nd line only; internal audit is for auditors, risk officers and admins', () => {
    expect(checkRoute('/risk', ['trader'])).toMatchObject({
      allow: false,
      feature: 'Risk console',
    });
    expect(checkRoute('/risk', ['novice', 'auditor'])).toMatchObject({ allow: false });
    expect(checkRoute('/risk', ['risk_officer'])).toEqual({ allow: true });
    expect(checkRoute('/internal-audit', ['novice', 'auditor'])).toEqual({ allow: true });
    expect(checkRoute('/internal-audit', ['trader'])).toMatchObject({
      allow: false,
      feature: 'Internal audit',
    });
    expect(landingPath(['novice', 'auditor'], 'pro')).toBe('/internal-audit');
    expect(landingPath(['novice', 'trader'], 'pro')).toBe('/terminal');
    expect(landingPath(['novice'], 'novice')).toBe('/home');
  });
  it('knows public paths', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/signup')).toBe(true);
    expect(isPublicPath('/api/health')).toBe(true);
    expect(isPublicPath('/_next/static/x.js')).toBe(true);
    expect(isPublicPath('/terminal')).toBe(false);
    expect(isPublicPath('/loginx')).toBe(false);
  });
});

describe('mode switching', () => {
  it('maps to the counterpart screen and keeps the instrument', () => {
    expect(counterpartPath('/terminal', 'novice', '?symbol=XAUUSD')).toBe(
      '/home?symbol=XAUUSD&switched=novice',
    );
    expect(counterpartPath('/home', 'pro', '')).toBe('/terminal?switched=pro');
    expect(counterpartPath('/robots/builder', 'novice')).toBe('/auto-invest?switched=novice');
    expect(counterpartPath('/settings', 'pro')).toBe('/settings?switched=pro');
    expect(counterpartPath('/unknown', 'pro')).toBe('/terminal?switched=pro');
  });
  it('classifies routes', () => {
    expect(isNoviceRoute('/learn')).toBe(true);
    expect(isProRoute('/robots/builder')).toBe(true);
    expect(isProRoute('/home')).toBe(false);
  });
});
