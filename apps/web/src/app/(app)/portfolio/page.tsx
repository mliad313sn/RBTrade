import { Portfolio } from '@/components/portfolio/Portfolio';

export const metadata = { title: 'Portfolio' };

/** Pro portfolio (IRTC R5-11): equity, P&L by period, positions and fills from the paper engine. */
export default function Page() {
  return <Portfolio />;
}
