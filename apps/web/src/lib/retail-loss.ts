/**
 * IRTC R4-18: the regulatory retail-loss sentence comes from the disclosures registry value
 * (`risk-warning` → `values.retailLossPct`), never a literal. While Compliance has not published the
 * figure the registry renders the `[XX]` placeholder and the sentence stays visibly unfinished.
 */
export const RETAIL_LOSS_PLACEHOLDER = '[XX]';

export function retailLossSentence(pct: string | null | undefined): string {
  const value = pct?.trim() || RETAIL_LOSS_PLACEHOLDER;
  if (value === RETAIL_LOSS_PLACEHOLDER)
    return `${RETAIL_LOSS_PLACEHOLDER}% of retail CFD accounts lose money with this provider: [INSERT REGULATORY FIGURE].`;
  return `${value}% of retail CFD accounts lose money with this provider.`;
}
