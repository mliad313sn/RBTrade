import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AnthropicProvider,
  loadAiConfig,
  unavailableReason,
  type AiProvider,
} from '../../../apps/api/src/ai/core';
import { loadCases, runCase, scripted, summarise } from './harness';

/**
 * CLI: `pnpm evals` (scripted provider, deterministic, runs in CI) or `pnpm evals:live` (Anthropic,
 * needs ANTHROPIC_API_KEY and KORA_AI_MODEL). Writes `reports/<provider>.json` and exits non-zero
 * below the thresholds.
 */
async function main() {
  const args = process.argv.slice(2);
  const providerArg = args[args.indexOf('--provider') + 1] ?? 'scripted';
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
  let make: (persona: 'reference' | 'adversarial') => AiProvider;
  if (providerArg === 'live') {
    const cfg = loadAiConfig({ ...process.env, KORA_AI_PROVIDER: 'anthropic' });
    const reason = unavailableReason(cfg);
    if (reason) {
      process.stderr.write(
        `Live eval not possible: ${reason}. Set ANTHROPIC_API_KEY and KORA_AI_MODEL.\n`,
      );
      process.exit(2);
    }
    const live = new AnthropicProvider(cfg);
    // Adversarial cases exercise the server's defences with the scripted hostile model even in live runs.
    make = (persona) => (persona === 'adversarial' ? scripted('adversarial') : live);
  } else {
    make = scripted;
  }
  const cases = loadCases().filter((c) => !only || c.id.startsWith(only) || c.category === only);
  const results = [];
  for (const c of cases) results.push(await runCase(c, make));
  const summary = summarise(providerArg, results);
  const out = join(__dirname, '..', 'reports');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${providerArg}.json`), JSON.stringify({ summary, results }, null, 2));

  const w = (s: string) => process.stdout.write(`${s}\n`);
  for (const r of results) {
    if (!r.pass) {
      w(`FAIL ${r.id} [${r.category}]`);
      for (const g of r.grades.filter((x) => !x.pass)) w(`     ${g.grader}: ${g.detail}`);
    }
  }
  w('');
  w(`KORA copilot evals · provider=${providerArg} · ${summary.passed}/${summary.cases} cases`);
  for (const [cat, s] of Object.entries(summary.byCategory))
    w(
      `  ${cat.padEnd(22)} ${String(s.passed).padStart(3)}/${String(s.cases).padEnd(3)} ${(s.score * 100).toFixed(1)}%`,
    );
  w(
    `  ${'overall'.padEnd(22)} ${(summary.overall * 100).toFixed(1)}%  (threshold ${summary.thresholds.overall * 100}%; injection, refusal, news injection and trend explanation 100%)`,
  );
  w(summary.ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(summary.ok ? 0 : 1);
}

void main();
