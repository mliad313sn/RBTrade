import Link from 'next/link';

import { API_INTERNAL_URL } from '@/lib/api-server';
import type { ReliabilityData } from '@/lib/intel/client';

export const metadata = { title: 'Forecast reliability' };
export const dynamic = 'force-dynamic';

async function load(): Promise<ReliabilityData | null> {
  try {
    const res = await fetch(`${API_INTERNAL_URL()}/intel/reliability`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    return res.ok ? ((await res.json()) as ReliabilityData) : null;
  } catch {
    return null;
  }
}

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);

/**
 * Public track record (goal 07B §7): per model and region, computed by the api from forecasts that
 * were stored with their timestamp before the outcome was known. No login needed.
 */
export default async function ReliabilityPage() {
  const data = await load();
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-6" data-testid="reliability-page">
      <header>
        <h1 className="m-0 font-display text-2xl">Forecast reliability</h1>
        <p className="m-0 mt-1 text-sm text-muted">
          KORA Market Radar trend forecasts on SIMULATED data (PAPER platform). {data?.method ?? ''}
        </p>
      </header>
      {!data && <p role="alert">The track record is not available right now.</p>}
      {data && !data.models.length && (
        <p className="text-sm text-muted">No forecasts have been recorded yet.</p>
      )}
      {data?.models.map((m) => (
        <section
          key={m.modelKey}
          className="rounded border border-border bg-panel p-3"
          data-testid="reliability-model"
          aria-labelledby={`h-${m.modelKey}`}
        >
          <h2 id={`h-${m.modelKey}`} className="m-0 text-base font-semibold">
            {m.regionLabel} · {m.horizon} · model {m.model}
          </h2>
          <p className="m-0 text-sm" data-testid="reliability-edge">
            {m.edge === 'positive'
              ? 'Skill after costs on past forecasts.'
              : m.edge === 'none'
                ? 'No edge after costs.'
                : m.edgeStatement}
          </p>
          <table className="mt-2 w-full text-sm">
            <caption className="sr-only">Forecast counts and hit rates</caption>
            <thead>
              <tr className="text-left text-muted">
                <th scope="col">Track record</th>
                <th scope="col">Forecasts</th>
                <th scope="col">Resolved</th>
                <th scope="col">Hit rate after costs</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" className="text-left font-normal">
                  Live (logged before the outcome)
                </th>
                <td className="k-num">{m.live.forecasts}</td>
                <td className="k-num">{m.live.resolved}</td>
                <td className="k-num">{pct(m.live.hitRate)}</td>
              </tr>
              <tr>
                <th scope="row" className="text-left font-normal">
                  Walk-forward replay (out of sample)
                </th>
                <td className="k-num">{m.replay.forecasts}</td>
                <td className="k-num">{m.replay.resolved}</td>
                <td className="k-num">{pct(m.replay.hitRate)}</td>
              </tr>
            </tbody>
          </table>
          {m.bins.length > 0 && (
            <table className="mt-2 w-full text-sm" data-testid="reliability-bins">
              <caption className="text-left text-xs text-muted">
                When we said… it happened… (bins with at least one forecast; a figure is shown in
                the app only with n ≥ {m.minN} and an edge after costs)
              </caption>
              <thead>
                <tr className="text-left text-muted">
                  <th scope="col">Stated</th>
                  <th scope="col">Mean stated</th>
                  <th scope="col">Happened</th>
                  <th scope="col">n</th>
                </tr>
              </thead>
              <tbody>
                {m.bins.map((b) => (
                  <tr key={b.lo}>
                    <td className="k-num">
                      {b.lo.toFixed(1)}–{b.hi.toFixed(1)}
                    </td>
                    <td className="k-num">
                      {b.meanPredicted === null ? '—' : b.meanPredicted.toFixed(2)}
                    </td>
                    <td className="k-num">{pct(b.observed)}</td>
                    <td className="k-num">{b.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
      <p className="m-0 text-xs text-muted">
        All market data and news are SIMULATED until licensed data contracts exist.{' '}
        {data?.disclaimer ?? 'Not investment advice.'}{' '}
        <Link href="/login" className="underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
