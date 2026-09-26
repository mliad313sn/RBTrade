import { DbService } from '../db/db.service';

/**
 * Record-keeping retention policy (goal 09). Periods are **placeholders** until Compliance sets them
 * (OQ-R4): `null` means "retain; no automatic deletion". A period is configured per class with
 * `KORA_RETENTION_<CLASS>_DAYS` (e.g. KORA_RETENTION_ORDERS_DAYS). The report is a dry run: the
 * application never deletes regulated records; append-only tables refuse deletion outright. The
 * market-data tick tables keep their technical 7-day retention from goal 02.
 */
export interface RetentionClass {
  id: string;
  label: string;
  table: string;
  tsColumn: string;
  classification: 'regulated_record' | 'personal_data' | 'operational' | 'licensed_content' | 'market_data';
  /** Default period in days; null = placeholder, retain until Compliance sets it. */
  defaultDays: number | null;
  basis: string;
  disposal: string;
  openQuestion: string | null;
}

export const RETENTION_CLASSES: RetentionClass[] = [
  { id: 'audit_events', label: 'Audit log', table: 'audit_events', tsColumn: 'ts', classification: 'regulated_record', defaultDays: null, basis: 'Record-keeping obligation (period to be set by Compliance)', disposal: 'Never deleted by the application (append-only, hash-chained); archive to WORM storage', openQuestion: 'OQ-R4' },
  { id: 'orders', label: 'Orders', table: 'orders', tsColumn: 'created_at', classification: 'regulated_record', defaultDays: null, basis: 'Order record-keeping (period to be set by Compliance)', disposal: 'Archive, then delete after the period (not automated)', openQuestion: 'OQ-R4' },
  { id: 'fills', label: 'Fills (executions)', table: 'fills', tsColumn: 'ts', classification: 'regulated_record', defaultDays: null, basis: 'Transaction record-keeping (period to be set by Compliance)', disposal: 'Append-only; archive after the period', openQuestion: 'OQ-R4' },
  { id: 'ledger_entries', label: 'Ledger entries', table: 'ledger_entries', tsColumn: 'created_at', classification: 'regulated_record', defaultDays: null, basis: 'Client money / accounting records (period to be set by Compliance)', disposal: 'Append-only; archive after the period', openQuestion: 'OQ-R4' },
  { id: 'disclosure_acknowledgements', label: 'Disclosure acknowledgements', table: 'disclosure_acknowledgements', tsColumn: 'created_at', classification: 'regulated_record', defaultDays: null, basis: 'Evidence of disclosures given (period to be set by Compliance)', disposal: 'Append-only; archive after the period', openQuestion: 'OQ-R4' },
  { id: 'questionnaire_attempts', label: 'Appropriateness / knowledge / suitability attempts', table: 'questionnaire_attempts', tsColumn: 'created_at', classification: 'regulated_record', defaultDays: null, basis: 'Evidence of assessments (scores only, answers never stored)', disposal: 'Archive after the period', openQuestion: 'OQ-R4' },
  { id: 'four_eyes_requests', label: 'Four-eyes approvals', table: 'four_eyes_requests', tsColumn: 'requested_at', classification: 'regulated_record', defaultDays: null, basis: 'Evidence of segregation of duties', disposal: 'Never deleted (trigger); archive', openQuestion: 'OQ-R4' },
  { id: 'incidents', label: 'Incident register', table: 'incidents', tsColumn: 'logged_at', classification: 'operational', defaultDays: null, basis: 'Operational resilience evidence', disposal: 'Never deleted (trigger); archive', openQuestion: 'OQ-R4' },
  { id: 'alerts', label: 'Risk and operations alerts', table: 'alerts', tsColumn: 'created_at', classification: 'operational', defaultDays: null, basis: 'Monitoring evidence', disposal: 'Archive after the period', openQuestion: 'OQ-R4' },
  { id: 'reconciliation_runs', label: 'Reconciliation runs', table: 'reconciliation_runs', tsColumn: 'started_at', classification: 'operational', defaultDays: null, basis: 'Reconciliation evidence', disposal: 'Archive after the period', openQuestion: 'OQ-R4' },
  { id: 'users', label: 'User profiles (personal data)', table: 'users', tsColumn: 'created_at', classification: 'personal_data', defaultDays: null, basis: 'Account lifetime plus a period after closure (to be set by Compliance / data protection)', disposal: 'Pseudonymise after the period; regulated records keep the pseudonymous id', openQuestion: 'OQ-P1' },
  { id: 'ai_predictions', label: 'AI forecasts and calibration inputs', table: 'ai_predictions', tsColumn: 'predicted_at', classification: 'operational', defaultDays: null, basis: 'Model monitoring (track record)', disposal: 'Archive after the period', openQuestion: 'OQ-R4' },
  { id: 'news_articles', label: 'News articles (licensed content)', table: 'news_articles', tsColumn: 'ingested_at', classification: 'licensed_content', defaultDays: null, basis: 'Per the news licence (OQ-M4)', disposal: 'Delete per licence terms', openQuestion: 'OQ-M4' },
  { id: 'md_trades', label: 'Market-data trade ticks', table: 'md_trades', tsColumn: 'ts', classification: 'market_data', defaultDays: 7, basis: 'Technical retention (goal 02); SIMULATED data', disposal: 'Deleted by the feed after 7 days', openQuestion: null },
  { id: 'md_bars_1s', label: 'Market-data 1 s bars', table: 'md_bars_1s', tsColumn: 'ts', classification: 'market_data', defaultDays: 7, basis: 'Technical retention (goal 02); SIMULATED data', disposal: 'Deleted by the feed after 7 days', openQuestion: null },
];

export function retentionDays(c: RetentionClass, env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[`KORA_RETENTION_${c.id.toUpperCase()}_DAYS`]?.trim();
  if (raw && /^\d{1,6}$/.test(raw)) return Number(raw);
  return c.defaultDays;
}

export interface RetentionRow {
  id: string;
  label: string;
  classification: RetentionClass['classification'];
  periodDays: number | null;
  placeholder: boolean;
  basis: string;
  disposal: string;
  openQuestion: string | null;
  records: number;
  oldest: string | null;
  beyondPeriod: number;
}

/** Dry-run retention report: nothing is deleted. */
export async function retentionReport(db: DbService, env: NodeJS.ProcessEnv = process.env): Promise<RetentionRow[]> {
  const out: RetentionRow[] = [];
  for (const c of RETENTION_CLASSES) {
    const days = retentionDays(c, env);
    // Identifiers come from the constant list above, never from input.
    const r = await db.query<{ n: string; oldest: Date | null; beyond: string }>(
      `SELECT count(*)::text AS n, min(${c.tsColumn}) AS oldest,
         count(*) FILTER (WHERE $1::int IS NOT NULL AND ${c.tsColumn} < now() - make_interval(days => $1::int))::text AS beyond
       FROM ${c.table}`,
      [days],
    );
    out.push({
      id: c.id,
      label: c.label,
      classification: c.classification,
      periodDays: days,
      placeholder: days === null,
      basis: c.basis,
      disposal: c.disposal,
      openQuestion: c.openQuestion,
      records: Number(r[0]?.n ?? 0),
      oldest: r[0]?.oldest?.toISOString() ?? null,
      beyondPeriod: Number(r[0]?.beyond ?? 0),
    });
  }
  return out;
}
