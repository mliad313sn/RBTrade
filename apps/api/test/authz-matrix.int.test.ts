// Goal 10 (S9): authorisation matrix for every HTTP endpoint × role.
//
// The routes are enumerated from the running Nest application (controller + handler metadata:
// path, method, @Public, @Roles), cross-checked against the OpenAPI document, then every route is
// called anonymously and as each role:
// - anonymous → 401 unless the route is public (public routes must be on the reviewed list below);
// - a role outside @Roles → 403 from the guard (`error: 'forbidden'`);
// - a role inside @Roles (or any signed-in role when there is no @Roles) → never 401 and never the
//   guard's 403 (a service-level 403 such as ownership is recorded, not a failure).
// The resulting matrix is written to docs/security/authz-matrix.md when KORA_WRITE_AUTHZ_MATRIX=1.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { ROLES, type Role } from '@kora/domain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IS_PUBLIC, ROLES as ROLES_KEY } from '../src/auth/decorators';
import { buildOpenApi } from '../src/create-app';
import { CSRF, bearer, createUser, startApp, type TestUser } from './helpers';

interface Route {
  method: string;
  path: string; // Express form, e.g. /orders/:id
  openapi: string; // OpenAPI form, e.g. /orders/{id}
  isPublic: boolean;
  roles: Role[] | null;
  controller: string;
}

/** Public routes reviewed by S9. Anything else marked @Public() fails this test until reviewed. */
const REVIEWED_PUBLIC: Record<string, string> = {
  'GET /health': 'liveness/readiness probe, no data',
  'GET /metrics': 'Prometheus scrape; bearer KORA_METRICS_TOKEN required outside dev/test',
  'GET /auth/.well-known/openid-configuration': 'OIDC discovery (dev IdP)',
  'GET /auth/jwks.json': 'public verification keys',
  'POST /auth/signup': 'sign-up (rate limited, generic answer B-014)',
  'POST /auth/login': 'sign-in (rate limited, lockout)',
  'POST /auth/mfa/enroll': 'needs the short-lived mfaToken from login',
  'POST /auth/mfa/verify': 'needs the short-lived mfaToken from login',
  'POST /auth/mfa/recovery': 'needs the short-lived mfaToken from login (B-902)',
  'GET /auth/oidc/start': 'Keycloak BFF redirect (AUTH_PROVIDER=keycloak only)',
  'GET /auth/oidc/callback': 'Keycloak BFF callback (state + PKCE)',
  'GET /intel/reliability': 'public SIMULATED track record (OQ-A4)',
};
/** Routes deliberately left out of the OpenAPI document (browser redirects and the scrape endpoint). */
const NOT_IN_OPENAPI = new Set(['GET /auth/oidc/start', 'GET /auth/oidc/callback', 'GET /metrics']);
/** Public controllers guarded by their own guard (service token); anonymous calls must be refused. */
const SERVICE_TOKEN_PREFIX = '/internal/';

const SAMPLE_PARAMS: Record<string, string> = {
  symbol: 'EURUSD',
  mic: 'XNYS',
  source: 'simulated',
  lesson: 'what-is-a-trade',
};

function samplePath(path: string): string {
  return path.replace(
    /:(\w+)/g,
    (_, name: string) => SAMPLE_PARAMS[name] ?? '00000000-0000-4000-8000-000000000000',
  );
}

function joinPath(a: string, b: string): string {
  const p = `/${[a, b].filter(Boolean).join('/')}`.replace(/\/+/g, '/');
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

function enumerateRoutes(app: INestApplication): Route[] {
  const routes: Route[] = [];
  const modules = app.get(ModulesContainer);
  for (const mod of modules.values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype as (new (...a: unknown[]) => unknown) | null;
      if (!cls) continue;
      const base = (Reflect.getMetadata(PATH_METADATA, cls) as string | undefined) ?? '';
      const proto = cls.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const handler = proto[name];
        if (typeof handler !== 'function') continue;
        const sub = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
        if (sub === undefined) continue;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
        const isPublic = Boolean(
          Reflect.getMetadata(IS_PUBLIC, handler) ?? Reflect.getMetadata(IS_PUBLIC, cls),
        );
        const roles = (Reflect.getMetadata(ROLES_KEY, handler) ??
          Reflect.getMetadata(ROLES_KEY, cls) ??
          null) as Role[] | null;
        for (const s of Array.isArray(sub) ? sub : [sub]) {
          const path = joinPath(base, s);
          routes.push({
            method: method!,
            path,
            openapi: path.replace(/:(\w+)/g, '{$1}'),
            isPublic,
            roles,
            controller: cls.name,
          });
        }
      }
    }
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

type Outcome = { status: number; guard403: boolean };

async function call(app: INestApplication, r: Route, token?: string): Promise<Outcome> {
  const http = app.getHttpServer();
  const m = r.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  let req = request(http)[m](samplePath(r.path)).set(CSRF).timeout(15_000);
  if (token) req = req.set(bearer(token));
  if (m !== 'get' && m !== 'delete') req = req.send({});
  const res = await req;
  const body = res.body as { error?: string; requiredRoles?: unknown } | undefined;
  return {
    status: res.status,
    guard403:
      res.status === 403 && body?.error === 'forbidden' && Array.isArray(body.requiredRoles),
  };
}

describe('authorisation matrix (every endpoint × role)', () => {
  let app: INestApplication;
  let routes: Route[];
  const users: Partial<Record<Role, TestUser>> = {};
  const matrix: Array<{ route: Route; anon: number; byRole: Partial<Record<Role, Outcome>> }> = [];

  beforeAll(async () => {
    app = await startApp();
    routes = enumerateRoutes(app);
    users.novice = await createUser(app, 'novice');
    users.trader = await createUser(app, 'trader');
    users.quant = await createUser(app, 'novice', ['quant']);
    users.risk_officer = await createUser(app, 'novice', ['risk_officer']);
    users.admin = await createUser(app, 'novice', ['admin']);
    users.auditor = await createUser(app, 'novice', ['auditor']);
  }, 180_000);

  afterAll(async () => {
    if (process.env.KORA_WRITE_AUTHZ_MATRIX === '1' && matrix.length) writeMatrix(matrix);
    await app?.close();
  });

  it('enumerates the routes and every route is in the OpenAPI document', () => {
    expect(routes.length).toBeGreaterThan(150);
    const doc = buildOpenApi(app);
    const missing = routes
      .filter(
        (r) =>
          !NOT_IN_OPENAPI.has(`${r.method} ${r.path}`) &&
          !doc.paths[r.openapi]?.[r.method.toLowerCase() as 'get'],
      )
      .map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
    const documented = Object.entries(doc.paths).flatMap(([p, ops]) =>
      Object.keys(ops as object).map((m) => `${m.toUpperCase()} ${p}`),
    );
    const known = new Set(routes.map((r) => `${r.method} ${r.openapi}`));
    expect(documented.filter((d) => !known.has(d))).toEqual([]);
  });

  it('every public route is reviewed; service routes refuse anonymous callers', async () => {
    const unreviewed = routes.filter(
      (r) =>
        r.isPublic &&
        !r.path.startsWith(SERVICE_TOKEN_PREFIX) &&
        !REVIEWED_PUBLIC[`${r.method} ${r.path}`],
    );
    expect(unreviewed.map((r) => `${r.method} ${r.path}`)).toEqual([]);
    for (const r of routes.filter((x) => x.path.startsWith(SERVICE_TOKEN_PREFIX))) {
      expect(r.isPublic, `${r.path} uses its own service-token guard`).toBe(true);
      const anon = await call(app, r);
      expect([401, 403], `${r.method} ${r.path} anonymous`).toContain(anon.status);
      // A user's session token is not a service token.
      const asAdmin = await call(app, r, users.admin!.token);
      expect([401, 403], `${r.method} ${r.path} as admin`).toContain(asAdmin.status);
    }
  });

  it('anonymous → 401; disallowed role → guard 403; allowed role → never 401/guard 403', async () => {
    const failures: string[] = [];
    for (const r of routes) {
      if (r.path.startsWith(SERVICE_TOKEN_PREFIX)) continue;
      if (r.method === 'POST' && r.path === '/auth/logout') continue; // would revoke the shared test sessions
      const row = { route: r, anon: 0, byRole: {} as Partial<Record<Role, Outcome>> };
      if (!r.isPublic) {
        const anon = await call(app, r);
        row.anon = anon.status;
        if (anon.status !== 401) failures.push(`${r.method} ${r.path} anonymous → ${anon.status}`);
      }
      for (const role of ROLES) {
        const u = users[role]!;
        const out = await call(app, r, u.token);
        row.byRole[role] = out;
        if (r.isPublic) continue;
        const allowed =
          !r.roles || r.roles.length === 0 || u.roles.some((x) => r.roles!.includes(x));
        if (allowed && (out.status === 401 || out.guard403))
          failures.push(`${r.method} ${r.path} as ${role} (allowed) → ${out.status}`);
        if (!allowed && !out.guard403)
          failures.push(`${r.method} ${r.path} as ${role} (not allowed) → ${out.status}`);
        if (out.status >= 500 && out.status !== 502 && out.status !== 503)
          failures.push(`${r.method} ${r.path} as ${role} → ${out.status} (server error)`);
      }
      matrix.push(row);
    }
    expect(failures).toEqual([]);
  }, 600_000);
});

function writeMatrix(
  rows: Array<{ route: Route; anon: number; byRole: Partial<Record<Role, Outcome>> }>,
): void {
  const head = `# Authorisation matrix (generated)

Generated by \`apps/api/test/authz-matrix.int.test.ts\` with \`KORA_WRITE_AUTHZ_MATRIX=1\` (goal 10).
Each cell is the HTTP status for a call with an empty body and sample path parameters:
**403g** = refused by the role guard, **401** = not signed in; any other status means the request
passed authorisation (400/404/409/422 are validation or business answers). "Rule" is the declared
\`@Roles\` (\`any\` = every signed-in role, \`public\` = reviewed public route). Owner-level checks
(your own account, strategy or robot) happen in the services and are covered by the module tests.

| Method | Path | Rule | anon | ${ROLES.join(' | ')} |
|---|---|---|---|${ROLES.map(() => '---').join('|')}|
`;
  const body = rows
    .map(({ route: r, anon, byRole }) => {
      const rule = r.isPublic ? 'public' : r.roles?.length ? r.roles.join(', ') : 'any';
      const cells = ROLES.map((role) => {
        const o = byRole[role];
        return o ? (o.guard403 ? '403g' : String(o.status)) : '';
      });
      return `| ${r.method} | \`${r.path}\` | ${rule} | ${r.isPublic ? '—' : anon} | ${cells.join(' | ')} |`;
    })
    .join('\n');
  writeFileSync(resolve(__dirname, '../../../docs/security/authz-matrix.md'), `${head}${body}\n`);
}
