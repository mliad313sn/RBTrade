import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Structural guarantee behind "no code path lets the AI submit, amend or cancel orders": the copilot
 * code never references an order-mutation, robot-control or version-saving API. Only `read-ports.ts`
 * may import the OMS / robots / strategies services, and it may only call read functions on them.
 */
const AI_DIR = __dirname;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory()
      ? files(p)
      : p.endsWith('.ts') && !p.endsWith('.test.ts')
        ? [p]
        : [];
  });
}

const FORBIDDEN_CALLS = [
  /\.submit\s*\(/,
  /\.amend\s*\(/,
  /\.cancel\s*\(/,
  /\.cancelAll\w*\s*\(/,
  /\.closePosition\s*\(/,
  /\.flatten\w*\s*\(/,
  /\.newVersion\s*\(/,
  /\.promote\s*\(/,
  /\.signoff\s*\(/,
  /\.start\s*\(/,
  /\.pause\s*\(/,
  /\.switchVersion\s*\(/,
  /\.updateLimits\s*\(/,
  /\.halt\w*\s*\(/,
  /\.resume\w*\s*\(/,
  /KillSwitchService/,
  /EngineLoopService/,
  /PaperEngineService/,
  /RobotControlService/,
  /RobotRuntimeService/,
  /PromotionService/,
  /INSERT\s+INTO\s+(orders|strategy_versions|robots)\b/i,
  /UPDATE\s+(orders|robots|strategy_versions)\b/i,
];

const PRIVILEGED_IMPORTS = [
  /trading\/oms\.service/,
  /robots\/robots\.service/,
  /strategies\/strategies\.service/,
  /strategies\/backtests\.service/,
];

describe('copilot code cannot reach execution paths (static)', () => {
  const all = files(AI_DIR);

  it('scans the whole ai module', () => {
    expect(all.length).toBeGreaterThan(15);
  });

  it.each(all.map((f) => [relative(AI_DIR, f), f]))(
    '%s has no order / robot / version mutation call',
    (_, f) => {
      const src = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/)/.test(l))
        .join('\n');
      for (const re of FORBIDDEN_CALLS) expect(src, `${re} in ${f}`).not.toMatch(re);
    },
  );

  it('only read-ports.ts imports the OMS, robots and strategies services', () => {
    for (const f of all) {
      const src = readFileSync(f, 'utf8');
      const imports = PRIVILEGED_IMPORTS.filter((re) => re.test(src));
      if (f.endsWith('read-ports.ts')) expect(imports.length).toBe(4);
      else expect(imports, f).toEqual([]);
    }
  });

  it('read-ports.ts only calls read functions (and the pure validator)', () => {
    const src = readFileSync(join(AI_DIR, 'read-ports.ts'), 'utf8');
    const calls = [...src.matchAll(/this\.(oms|robots|strategies|backtests)\.(\w+)\(/g)].map(
      (m) => `${m[1]}.${m[2]}`,
    );
    expect(new Set(calls)).toEqual(
      new Set([
        'oms.preview',
        'robots.list',
        'robots.detail',
        'robots.signals',
        'robots.signalFeatures',
        'strategies.get',
        'strategies.validate',
        'backtests.latestBacktest',
      ]),
    );
  });

  it('no model id or model name is hard-coded in the copilot', () => {
    for (const f of all)
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/claude-[a-z0-9]|\b(opus|sonnet|haiku)\b/i);
  });
});
