import { aiApi } from './client';

/**
 * Records the user's decision on an AI draft (goal 07 audit trail). Best effort: a failure here
 * never blocks or undoes the order the user placed.
 */
export async function recordAiDecision(
  draftId: string,
  body: { decision: 'accepted' | 'rejected'; orderId?: string; versionId?: string },
): Promise<void> {
  try {
    await aiApi.decide(draftId, body);
  } catch {
    /* already decided or offline: the order itself is unaffected */
  }
}
