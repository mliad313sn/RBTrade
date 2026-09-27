import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Structural guarantee behind "no code path lets the AI submit, amend or cancel orders": the copilot
 * code never references an order-mutation, robot-control or version-saving API. Only `read-ports.ts`
 * may import the OMS / robots / strategies services, and it may only call read functions on them.
 */
const AI_DIR = __dirname;

/** IRTC R4-16: the intel module (which injects the AI services) is held to the same rules. */
const INTEL_DIR = join(__dirname, '..', 'intel');

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
  // IRTC R4-16: computed member calls (obj['submit'](...)) and dynamic service lookups.
  /\[\s*['"`](submit|amend|cancel\w*|closePosition|flatten\w*|newVersion|promote|signoff|start|pause|switchVersion|updateLimits|halt\w*|resume\w*)['"`]\s*\]/,
  /OmsService|RobotsService|StrategiesService|BacktestsService/,
  // IRTC R6-02: account writes and dynamic provider lookups are out of reach as well.
  /AccountsService/,
  /\.updateSettings\s*\(/,
  /\bModuleRef\b|\bmoduleRef\b/,
];

const PRIVILEGED_IMPORTS = [
  /trading\/accounts\.service/,
  /trading\/oms\.service/,
  /robots\/robots\.service/,
  /strategies\/strategies\.service/,
  /strategies\/backtests\.service/,
];

describe('copilot code cannot reach execution paths (static)', () => {
  const all = [...files(AI_DIR), ...files(INTEL_DIR)];

  it('the rules catch the evasions the review named (IRTC R4-16)', () => {
    const hits = (code: string) => FORBIDDEN_CALLS.some((re) => re.test(code));
    expect(hits("oms['submit'](sub, req)")).toBe(true);
    expect(hits('robots[`start`](id)')).toBe(true);
    expect(hits('const oms = this.moduleRef.get(OmsService, { strict: false });')).toBe(true);
    expect(hits('this.read.trendCard(symbol, horizon)')).toBe(false);
    // IRTC R6-02
    expect(hits("await this.accounts.updateSettings(user, { confirmMode: 'never' })")).toBe(true);
    expect(hits('constructor(private readonly moduleRef: ModuleRef) {}')).toBe(true);
  });

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
      for (const re of FORBIDDEN_CALLS) {
        // read-ports.ts is the one place that holds the OMS/robots/strategies services (read calls only, checked below).
        if (f.endsWith('read-ports.ts') && (re.source.startsWith('OmsService') || re.source === 'AccountsService')) continue;
        expect(src, `${re} in ${f}`).not.toMatch(re);
      }
    },
  );

  it('no file in the ai or intel module uses ModuleRef (IRTC R6-02: no dynamic provider lookups)', () => {
    for (const f of all) expect(readFileSync(f, 'utf8'), f).not.toMatch(/@nestjs\/core|\bModuleRef\b/);
  });

  it('only read-ports.ts imports the accounts, OMS, robots and strategies services', () => {
    for (const f of all) {
      const src = readFileSync(f, 'utf8');
      const imports = PRIVILEGED_IMPORTS.filter((re) => re.test(src));
      if (f.endsWith('read-ports.ts')) expect(imports.length).toBe(5);
      else expect(imports, f).toEqual([]);
    }
  });

  /**
   * IRTC R6-02: the tool code (the dispatcher's backend) may inject only this allow-list of read
   * ports. A new dependency (AccountsService, DbService, a Pool, Redis, ModuleRef, any writer) fails
   * here and needs a reviewed change to the list.
   */
  const TOOL_DEPS_ALLOWED = [
    'CandlesService', // candles and instrument specs (read)
    'ChannelHub', // last quote from Redis (read)
    'AiReadPorts', // read-only facade over accounts, OMS preview, robots, strategies, backtests
    'CalibrationService', // calibration tables (reads; rebuilds its own derived cache only)
    'DraftsService', // the two draft tools: writes draft rows and their audit events only
    'QuantClient', // stateless Monte Carlo call to the quant service
    'IntelPortRegistry', // read-only intel port (radar, trend card, news)
    'MdConfig', // static config
  ];
  const constructorDeps = (src: string, cls: string): string[] => {
    const body = new RegExp(`class ${cls}[\\s\\S]*?constructor\\(([\\s\\S]*?)\\)\\s*\\{`).exec(src)?.[1] ?? '';
    return [...body.matchAll(/(?:private|public|protected)?\s*(?:readonly\s+)?\w+\s*:\s*([\w.]+)/g)].map((m) => m[1]!);
  };

  it('the tool backend injects only allow-listed read ports (IRTC R6-02)', () => {
    const src = readFileSync(join(AI_DIR, 'tool-backend.service.ts'), 'utf8');
    const deps = constructorDeps(src, 'AiToolBackend');
    expect(deps.length).toBeGreaterThanOrEqual(5);
    for (const d of deps) expect(TOOL_DEPS_ALLOWED, `AiToolBackend injects ${d}`).toContain(d);
  });

  it('the read ports inject only the services whose read calls are checked below (IRTC R6-02)', () => {
    const src = readFileSync(join(AI_DIR, 'read-ports.ts'), 'utf8');
    expect(constructorDeps(src, 'AiReadPorts').sort()).toEqual(
      ['AccountsService', 'BacktestsService', 'OmsService', 'RobotsService', 'StrategiesService'],
    );
  });

  it('the constructor scan sees an injected writer (self-check)', () => {
    const fake = 'class AiToolBackend {\n  constructor(\n    private readonly accounts: AccountsService,\n    private readonly db: DbService,\n    @Inject(MD_CONFIG) md: MdConfig,\n  ) {\n';
    expect(constructorDeps(fake, 'AiToolBackend')).toEqual(['AccountsService', 'DbService', 'MdConfig']);
  });

  it('tool code runs no SQL and reaches no private member by cast or computed key (IRTC R6-02)', () => {
    for (const name of ['tool-backend.service.ts', 'read-ports.ts', 'intel-port.ts']) {
      const src = readFileSync(join(AI_DIR, name), 'utf8');
      expect(src, name).not.toMatch(/db\/db\.service|DbService|\bPool\b|ioredis/);
      expect(src, name).not.toMatch(/\.query\s*[(<]|\.tx\s*\(/);
      expect(src, name).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE)\b/i);
      expect(src, name).not.toMatch(/as\s+unknown\s+as|as\s+any\b/);
      expect(src, name).not.toMatch(/this\.\w+\s*\[/);
    }
  });

  it('read-ports.ts only calls read functions (and the pure validator)', () => {
    const src = readFileSync(join(AI_DIR, 'read-ports.ts'), 'utf8');
    const calls = [...src.matchAll(/this\.(accounts|oms|robots|strategies|backtests)\.(\w+)\(/g)].map(
      (m) => `${m[1]}.${m[2]}`,
    );
    expect(new Set(calls)).toEqual(
      new Set([
        'accounts.ensure',
        'accounts.view',
        'accounts.positionsView',
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
    for (const f of all) expect(readFileSync(f, 'utf8'), f).not.toMatch(/claude-[a-z0-9]/i);
  });
});
