import { Appropriateness } from '@/components/Appropriateness';
import { localisedTitle } from '@/lib/i18n/metadata';

/** Localised page title (IRTC R5-12). */
export function generateMetadata() {
  return localisedTitle('meta.appropriateness', { sharedWithPro: true });
}

export default function AppropriatenessPage() {
  return <Appropriateness />;
}
