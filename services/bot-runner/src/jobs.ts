import { z } from 'zod';

/**
 * Jobs the runner accepts. Goal 01: heartbeat only. Goal 06 adds strategy ticks, which submit orders
 * exclusively through the OMS API (same path as humans) — the runner never talks to a broker.
 */
export const JobSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heartbeat'), at: z.iso.datetime() }).strict(),
]);
export type RunnerJob = z.infer<typeof JobSchema>;

export class RejectedJobError extends Error {}

export function handleJob(data: unknown): { ok: true; type: RunnerJob['type']; mode: 'PAPER' } {
  const parsed = JobSchema.safeParse(data);
  if (!parsed.success) throw new RejectedJobError(`Rejected job: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  return { ok: true, type: parsed.data.type, mode: 'PAPER' };
}
