/**
 * Plain-language glossary for the Novice Practice screen, and the jargon list that must not appear
 * there unless it sits inside a glossary link (goal 05 acceptance: plain-language review).
 */
export interface GlossaryTerm {
  id: string;
  term: string;
  meaning: string;
}

export const PRACTICE_GLOSSARY: GlossaryTerm[] = [
  {
    id: 'simulation',
    term: 'Simulation',
    meaning:
      'We play out 10,000 made-up years of trading with the choices you picked, to see the range of things that could happen. None of it is real money or a real forecast.',
  },
  {
    id: 'costs',
    term: 'Costs',
    meaning:
      'What every trade costs you, win or lose: the small gap between the buy and sell price, plus fees.',
  },
  {
    id: 'safety-net',
    term: 'Safety net',
    meaning:
      'An automatic sell that limits how much one trade can lose. In very fast markets the price can jump past it, so a loss can be a little larger.',
  },
  {
    id: 'range',
    term: 'Likely range',
    meaning: 'The shaded area on the chart. Most of the made-up years (9 in 10) stayed inside it.',
  },
];

/** Pro-only terms. Each must be absent from Practice copy, or appear only inside a glossary link. */
export const JARGON = [
  'monte carlo',
  'percentile',
  'p5',
  'p25',
  'p50',
  'p75',
  'p95',
  'median',
  'drawdown',
  'kelly',
  'expectancy',
  'r-multiple',
  'volatility',
  'leverage',
  'bootstrap',
  'stop loss',
  'fat tail',
  'ruin',
  'sharpe',
  'basis point',
  'slippage',
  'equity',
  'distribution',
  'variance',
  'stochastic',
] as const;

/** Returns the jargon terms found in `text` (case-insensitive, whole words, plurals, - or space). */
export function findJargon(text: string): string[] {
  const t = text.toLowerCase();
  return JARGON.filter((term) =>
    new RegExp(`(^|[^a-z0-9])${term.replace(/[-\s]/g, '[-\\s]')}s?($|[^a-z0-9])`).test(t),
  );
}
