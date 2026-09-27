import { Practice } from '@/components/sim/Practice';
import { serverClient } from '@/lib/api-server';
import { getT } from '@/lib/i18n/server';
import { localisedTitle } from '@/lib/i18n/metadata';

/** Localised page title (IRTC R5-12). */
export function generateMetadata() {
  return localisedTitle('nav.practice');
}

export default async function Page() {
  const [client, { locale, t }] = await Promise.all([serverClient(), getT()]);
  // OQ-Q1 (S1 + S8): show the regulatory retail-loss figure next to the practice year.
  const pct = await client
    .disclosure('risk-warning', locale)
    .then((r) => r.document.values.retailLossPct ?? null)
    .catch(() => null);
  return (
    <>
      <h1 className="k-sr-only">{t('nav.practice')}</h1>
      <Practice disclosurePct={pct} />
    </>
  );
}
