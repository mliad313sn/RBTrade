import { z } from 'zod';

/**
 * Incident workflow aligned with ITIL 4 incident management (goal 09): detect → log → classify →
 * resolve → post-incident review. Priority is impact × urgency (P1 highest). P1 and P2 need a
 * post-incident review reference before they can be closed.
 */
export const INCIDENT_STATES = ['logged', 'classified', 'resolved', 'closed'] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];

export const INCIDENT_PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type IncidentPriority = (typeof INCIDENT_PRIORITIES)[number];

export const INCIDENT_LEVELS = ['high', 'medium', 'low'] as const;
export type IncidentLevel = (typeof INCIDENT_LEVELS)[number];

export const INCIDENT_CATEGORIES = [
  'feed_outage',
  'engine_stall',
  'reconciliation_break',
  'ai_provider_outage',
  'kill_switch_fired',
  'database_restore',
  'security',
  'other',
] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];

/** ITIL-style priority matrix: impact × urgency. */
export function incidentPriority(impact: IncidentLevel, urgency: IncidentLevel): IncidentPriority {
  const score = { high: 3, medium: 2, low: 1 };
  const s = score[impact] + score[urgency];
  return s >= 6 ? 'P1' : s === 5 ? 'P2' : s >= 3 ? 'P3' : 'P4';
}

const NEXT: Record<IncidentState, IncidentState[]> = {
  logged: ['classified'],
  classified: ['resolved'],
  resolved: ['closed', 'classified'],
  closed: [],
};

export function canTransitionIncident(from: IncidentState, to: IncidentState): boolean {
  return NEXT[from].includes(to);
}

export function needsReview(priority: IncidentPriority | null): boolean {
  return priority === 'P1' || priority === 'P2';
}

const text = (max: number) => z.string().trim().min(3).max(max);

export const IncidentCreateSchema = z.strictObject({
  title: text(160),
  description: text(4000),
  category: z.enum(INCIDENT_CATEGORIES),
  detectedAt: z.iso.datetime({ offset: true }).optional(),
  alertId: z.uuid().optional(),
  exercise: z.boolean().default(false),
});

export const IncidentClassifySchema = z.strictObject({
  impact: z.enum(INCIDENT_LEVELS),
  urgency: z.enum(INCIDENT_LEVELS),
  category: z.enum(INCIDENT_CATEGORIES).optional(),
  note: text(1000).optional(),
});

export const IncidentResolveSchema = z.strictObject({
  resolution: text(4000),
});

export const IncidentCloseSchema = z.strictObject({
  reviewRef: z.string().trim().min(3).max(300).optional(),
  note: text(1000).optional(),
});
