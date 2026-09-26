#!/usr/bin/env node
/**
 * Tabletop exercise (goal 09): "kill switch fired + reconciliation break", run against the local
 * stack (native Postgres/Redis from scripts/dev-db.sh, the built api on a scratch port, the dev
 * database). Follows docs/runbooks/kill-switch-fired.md and docs/runbooks/reconciliation-break.md
 * and the ITIL 4 incident workflow, and prints a Markdown evidence log with ids and timings.
 *
 *   pnpm --filter @kora/api build && node apps/api/scripts/tabletop-kill-switch-recon.mjs > log.md
 *
 * Everything is PAPER and SIMULATED. The injected break is a deliberate, owner-level change to one
 * test account's cached cash (the ledger stays the source of truth), recorded in the log.
 */
import { spawn } from 'node:child_process';
import { createHmac, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
const PORT = Number(process.env.TABLETOP_API_PORT ?? 4020);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'correct-horse-battery-staple';
const CSRF = { 'x-kora-csrf': '1', 'content-type': 'application/json' };
const t0 = Date.now();
const log = [];
const out = (line = '') => {
  log.push(line);
  process.stdout.write(`${line}\n`);
};
const at = () => `T+${((Date.now() - t0) / 1000).toFixed(1)} s`;
const step = (title) => out(`\n### ${at()} — ${title}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
function totp(secret) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = mac[mac.length - 1] & 15;
  const bin = ((mac[o] & 127) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

async function api(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...CSRF, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* CSV / PDF */
  }
  return { status: res.status, data, headers: res.headers };
}

async function owner(sql, params = []) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL_MIGRATE });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

const uniq = (p) => `${p}.tabletop.${Date.now()}.${randomInt(1e6)}@tabletop.kora.local`;

/** Sign-up (novice) → optional appropriateness (trader) → optional extra role → MFA. */
async function user(kind, extra) {
  const email = uniq(kind);
  await api('POST', '/auth/signup', null, { email, password: PASSWORD, displayName: `Tabletop ${kind}` });
  let l = (await api('POST', '/auth/login', null, { email, password: PASSWORD })).data;
  let token = l.accessToken;
  const id = (await api('GET', '/me', token)).data.user.id;
  if (kind === 'trader') {
    const q = (await api('GET', '/appropriateness/questionnaire', token)).data.questionnaire;
    const answers = Object.fromEntries(
      (await import(resolve(root, 'apps/api/src/appropriateness/questionnaires/appropriateness.v1.json'), { with: { type: 'json' } })).default.questions.map((qq) => [
        qq.id,
        [...qq.options].sort((a, b) => b.points - a.points)[0].id,
      ]),
    );
    const r = await api('POST', '/appropriateness/attempts', token, { questionnaireId: q.id, version: q.version, answers });
    if (!r.data.passed) throw new Error('assessment not passed');
  }
  if (extra) await owner(`INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, extra]);
  if (kind === 'trader' || extra) {
    l = (await api('POST', '/auth/login', null, { email, password: PASSWORD })).data;
    const enr = (await api('POST', '/auth/mfa/enroll', null, { mfaToken: l.mfaToken })).data;
    token = (await api('POST', '/auth/mfa/verify', null, { mfaToken: l.mfaToken, code: totp(enr.secret) })).data.accessToken;
  }
  return { id, email, token };
}

async function main() {
  const api$ = spawn(process.execPath, ['dist/main.js'], {
    cwd: resolve(root, 'apps/api'),
    env: {
      ...process.env,
      API_PORT: String(PORT),
      KORA_ENV: 'dev',
      LOG_LEVEL: 'warn',
      KORA_AUTH_RATE_LIMIT: '1000',
      KORA_MD_FEED: 'inprocess',
      KORA_MD_BACKFILL: 'false',
      KORA_MD_SYMBOLS: 'BTCUSD,ETHUSD,EURUSD,GBPUSD,XAUUSD',
      KORA_MD_REDIS_PREFIX: 'kora:tabletop:md:',
      KORA_RECONCILIATION_INTERVAL_MS: '0',
      KORA_AUDIT_ANCHOR_DIR: resolve(root, '.data/audit-anchors'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const apiLogs = [];
  api$.stdout.on('data', (d) => apiLogs.push(d.toString()));
  api$.stderr.on('data', (d) => apiLogs.push(d.toString()));
  try {
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) break;
      } catch {
        /* starting */
      }
      if (i > 150) throw new Error(`api did not start: ${apiLogs.join('').slice(-2000)}`);
      await sleep(200);
    }
    out('# Tabletop evidence log — kill switch fired + reconciliation break');
    out('');
    out(`Run ${new Date(t0).toISOString()} against the local stack: api \`dist/main.js\` on :${PORT}, dev database \`kora\` (Postgres :${process.env.KORA_PG_PORT ?? 55432}), Redis :${process.env.KORA_REDIS_PORT ?? 56379}, in-process SIMULATED feed. PAPER only.`);

    step('Set-up: participants and positions (1st line)');
    const trader = await user('trader');
    const riskA = await user('novice', 'risk_officer');
    const riskB = await user('novice', 'risk_officer');
    const auditor = await user('novice', 'auditor');
    out(`- trader \`${trader.id}\`, risk officer A \`${riskA.id}\`, risk officer B \`${riskB.id}\`, auditor \`${auditor.id}\``);
    await sleep(1500); // let the feed publish quotes
    const q = (await api('GET', '/quotes?symbols=BTCUSD', trader.token)).data.quotes[0].quote;
    // A resting bid 3 % under the market (inside the fat-finger band), on the 0.5 tick grid.
    const restingBid = (Math.floor((Number(q.bid) * 0.97) / 0.5) * 0.5).toFixed(1);
    const orders = [
      { symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '0.2' },
      { symbol: 'ETHUSD', side: 'buy', type: 'market', qty: '3' },
      { symbol: 'BTCUSD', side: 'buy', type: 'limit', qty: '0.05', limitPrice: restingBid, tif: 'gtc' },
    ];
    for (const [i, o] of orders.entries()) {
      const r = await api('POST', '/orders', trader.token, { clientOrderId: `tabletop-${t0}-${i}`, ...o });
      out(`- order ${o.side} ${o.qty} ${o.symbol} ${o.type}${o.limitPrice ? ` @ ${o.limitPrice}` : ''}: HTTP ${r.status} → ${r.data.order?.status ?? r.data.code}`);
    }
    const acct = (await api('GET', '/accounts/me', trader.token)).data;
    out(`- trader account \`${acct.id}\`: equity ${acct.equity} ${acct.baseCurrency}, ${acct.openPositions} open positions`);

    step('Risk officer A opens the console (live channel risk:alerts)');
    const alerts = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise((r, j) => {
      ws.once('open', r);
      ws.once('error', j);
    });
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.ch === 'risk:alerts') alerts.push({ at: Date.now(), alert: m.data.alert });
    });
    ws.send(JSON.stringify({ op: 'auth', token: riskA.token }));
    await sleep(200);
    ws.send(JSON.stringify({ op: 'subscribe', channels: ['risk:alerts'], id: 'console' }));
    await sleep(300);
    out('- subscribed to `risk:alerts` as risk officer A');

    step('Detect: a reconciliation break is injected and found');
    const before = await owner('SELECT cash::text FROM accounts WHERE id = $1', [acct.id]);
    await owner(`UPDATE accounts SET cash = cash + 1000 WHERE id = $1`, [acct.id]);
    out(`- INJECTED (owner, exercise only): cached cash of \`${acct.id}\` ${before[0].cash} → +1000.00 (the ledger is untouched)`);
    const tRecon = Date.now();
    const recon = await api('POST', '/reconciliation/run', riskA.token);
    out(`- reconciliation run \`${recon.data.runId ?? recon.data.id ?? '?'}\`: ${recon.data.accountsChecked ?? '?'} accounts, mismatches: ${JSON.stringify(recon.data.mismatches?.filter?.((m) => m.accountId === acct.id) ?? recon.data.mismatches)}`);
    for (let i = 0; i < 50 && !alerts.some((a) => a.alert.kind === 'reconciliation.mismatch'); i++) await sleep(100);
    const reconAlert = alerts.find((a) => a.alert.kind === 'reconciliation.mismatch');
    out(`- console received \`reconciliation.mismatch\` (${reconAlert?.alert.severity}) ${reconAlert ? `${reconAlert.at - tRecon} ms after the run started` : 'NOT RECEIVED'}: "${reconAlert?.alert.message}"`);

    step('Log and classify the incident (ITIL 4)');
    const inc = (await api('POST', '/governance/incidents', riskA.token, {
      title: 'Tabletop: reconciliation break, firm halt',
      description: 'Cash cache differs from the ledger on one account. Firm-wide kill switch while investigating. Exercise.',
      category: 'reconciliation_break',
      alertId: reconAlert?.alert.id,
      exercise: true,
    })).data;
    out(`- logged ${inc.ref} (\`${inc.id}\`), status ${inc.status}`);
    const cls = (await api('POST', `/governance/incidents/${inc.id}/classify`, riskA.token, { impact: 'high', urgency: 'high', note: 'Book integrity in doubt' })).data;
    out(`- classified ${cls.priority} (impact high × urgency high)`);

    step('Contain: firm-wide kill switch (scope 3) from the console');
    const tKs = Date.now();
    const ks = await api('POST', '/risk-console/kill-switch', riskA.token, { scope: 'robots_cancel_flatten', reason: 'Tabletop: reconciliation break under investigation' });
    out(`- HTTP ${ks.status}: ${ks.data.accounts} accounts halted, ${ks.data.ordersCancelled} orders cancelled, ${ks.data.positionsFlattened} positions flattened, ${ks.data.failures?.length ?? 0} failures, ${ks.data.durationMs} ms (global id \`${ks.data.globalKillSwitchId}\`)`);
    await sleep(500);
    const fired = alerts.filter((a) => a.alert.kind === 'kill_switch.fired' && a.alert.accountId === acct.id)[0];
    out(`- console received \`kill_switch.fired\` for the trader account ${fired ? `${fired.at - tKs} ms after the request` : 'NOT RECEIVED'} (${fired?.alert.severity})`);
    const st = (await api('GET', '/kill-switch', trader.token)).data;
    out(`- trader state: halted=${st.halted}, scope=${st.scope}, haltedBy=\`${st.haltedBy}\`, resumeNeedsApproval=${st.resumeNeedsApproval}`);
    const pos = (await api('GET', '/positions', trader.token)).data.positions;
    out(`- trader positions after flatten: ${pos.length}`);

    step('Investigate and resolve (2nd line + engineering, runbook reconciliation-break)');
    const mism = await owner(
      `SELECT a.cash::text AS cached, (SELECT sum(amount)::text FROM ledger_entries WHERE account_id = a.id AND ledger_account = 'cash') AS ledger FROM accounts a WHERE a.id = $1`,
      [acct.id],
    );
    out(`- evidence: cached cash ${mism[0].cached} vs ledger ${mism[0].ledger} → the cache is wrong, the ledger is right (runbook step 3)`);
    await owner(`UPDATE accounts SET cash = (SELECT sum(amount) FROM ledger_entries WHERE account_id = $1 AND ledger_account = 'cash') WHERE id = $1`, [acct.id]);
    out('- fix (owner, under change control): cached cash reset to the ledger sum (runbook step 4)');
    const recon2 = await api('POST', '/reconciliation/run', riskA.token);
    const left = (recon2.data.mismatches ?? []).filter((m) => m.accountId === acct.id);
    out(`- re-run reconciliation: ${left.length} mismatch(es) left on the account (total run mismatches: ${(recon2.data.mismatches ?? []).length})`);
    const res = (await api('POST', `/governance/incidents/${inc.id}/resolve`, riskA.token, { resolution: 'Cash cache re-derived from the ledger; reconciliation clean. Root cause: injected in the exercise.' })).data;
    out(`- incident ${res.ref} ${res.status}`);

    step('Recover: resume needs four eyes (firm halt)');
    const ask = await api('POST', '/kill-switch/resume', trader.token, { reason: 'Reconciliation clean; positions flat; ready to trade' });
    out(`- trader asks to resume: HTTP ${ask.status}, request \`${ask.data.pendingApproval?.id}\` (${ask.data.pendingApproval?.status})`);
    const self = await api('POST', `/governance/approvals/${ask.data.pendingApproval.id}/approve`, trader.token, { note: 'self' });
    out(`- trader tries to approve their own request: HTTP ${self.status} (${self.data.error})`);
    const byA = await api('POST', `/kill-switch/resume?accountId=${acct.id}`, riskA.token, { reason: 'duplicate' });
    out(`- risk officer A tries to open a second request: HTTP ${byA.status} (${byA.data.error})`);
    const ok = await api('POST', `/governance/approvals/${ask.data.pendingApproval.id}/approve`, riskB.token, { note: 'Reviewed reconciliation evidence; independent approval' });
    out(`- risk officer B approves: HTTP ${ok.status}, status ${ok.data.status}, requestedBy \`${ok.data.requestedBy}\`, decidedBy \`${ok.data.decidedBy}\``);
    out(`- trader state: halted=${(await api('GET', '/kill-switch', trader.token)).data.halted}`);
    // Other accounts halted by the exercise are resumed through the same four-eyes path (owners
    // not present); here, for the dev database, they are released by the owner script afterwards.

    step('Post-incident review and closure');
    const closeNoRef = await api('POST', `/governance/incidents/${inc.id}/close`, riskA.token, {});
    out(`- close without a review reference: HTTP ${closeNoRef.status} (${closeNoRef.data.error})`);
    const closed = (await api('POST', `/governance/incidents/${inc.id}/close`, riskA.token, { reviewRef: 'docs/runbooks/tabletop-kill-switch-reconciliation.md' })).data;
    out(`- closed ${closed.ref} with review ${closed.reviewRef}`);

    step('3rd line: verification, anchors, evidence and sampling');
    const anchor = (await api('POST', '/internal-audit/anchors', riskA.token)).data;
    out(`- anchor #${anchor.id}: head ${anchor.headId} ${anchor.headHash?.slice(0, 16)}…, signature ${anchor.signatureValid}, in chain ${anchor.matchesChain}`);
    const v = (await api('GET', '/internal-audit/verify', auditor.token)).data;
    out(`- auditor verifies: chain valid=${v.chain.valid}, ${v.chain.count} events, anchors ${v.anchors.count} (bad ${v.anchors.invalidSignatures + v.anchors.notMatchingChain})`);
    const from = new Date(t0 - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    for (const id of ['KC-07', 'KC-17', 'KC-20', 'KC-25']) {
      const e = await api('GET', `/governance/controls/${id}/evidence?format=csv&from=${from}&to=${to}`, auditor.token);
      out(`- evidence ${id} CSV: HTTP ${e.status}, ${e.headers.get('x-kora-evidence-rows')} rows, sha256 ${e.headers.get('x-kora-evidence-sha256')?.slice(0, 16)}…`);
    }
    const s = (await api('GET', `/internal-audit/sample?controlId=KC-17&n=3&seed=tabletop&from=${from}&to=${to}`, auditor.token)).data;
    out(`- sample KC-17 (seed ${s.seed}): ${s.drawn} of ${s.population} kill-switch events: ${s.events?.map((e) => `#${e.id} ${e.action}`).join(', ')}`);
    const trail = await owner(
      `SELECT action, count(*)::int AS n FROM audit_events WHERE ts >= to_timestamp($1 / 1000.0) AND action ~ '^(kill_switch|risk|four_eyes|incident|reconciliation|internal_audit|governance)\\.' GROUP BY action ORDER BY action`,
      [t0],
    );
    out('- audit trail of the exercise:');
    for (const r of trail) out(`  - \`${r.action}\` × ${r.n}`);
    out(`\nTotal duration ${((Date.now() - t0) / 1000).toFixed(1)} s. Alerts received on the console: ${alerts.length}.`);
    ws.close();
    // Release the other dev accounts the firm halt caught (dev database only; not a production step).
    const released = await owner(`UPDATE accounts SET trading_halted = false, halt_scope = NULL, halted_at = NULL, halted_by = NULL, halt_reason = NULL WHERE trading_halted RETURNING id`);
    out(`(dev clean-up: ${released.length} other exercise-halted dev account(s) released by the owner.)`);
  } finally {
    api$.kill('SIGTERM');
  }
}

main().catch((e) => {
  process.stderr.write(`${e.stack ?? e}\n`);
  process.exit(1);
});
