import { z } from 'zod';

/**
 * Jobs the runner accepts. The runner never talks to a broker and never places an order itself: a
 * `bar_close` job asks the api for the point-in-time context, asks quant for the decision, and hands
 * the decision back to the api, which submits through the OMS (same path as humans, B-301).
 */
export const BarCloseJobSchema = z
  .object({
    type: z.literal('bar_close'),
    robotId: z.uuid(),
    symbol: z.string().min(1).max(32),
    tf: z.enum(['1m', '5m', '15m', '1h', '4h', '1D']),
    barTs: z.number().int().min(0),
  })
  .strict();
export type BarCloseJob = z.infer<typeof BarCloseJobSchema>;

export const JobSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heartbeat'), at: z.iso.datetime() }).strict(),
  BarCloseJobSchema,
  z.object({ type: z.literal('tracking'), day: z.iso.date().optional() }).strict(),
]);
export type RunnerJob = z.infer<typeof JobSchema>;

export class RejectedJobError extends Error {}

export function parseJob(data: unknown): RunnerJob {
  const parsed = JobSchema.safeParse(data);
  if (!parsed.success)
    throw new RejectedJobError(
      `Rejected job: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  return parsed.data;
}

export function handleJob(data: unknown): { ok: true; type: RunnerJob['type']; mode: 'PAPER' } {
  return { ok: true, type: parseJob(data).type, mode: 'PAPER' };
}

/** Deterministic job id: one evaluation per robot, symbol and bar, however many times it closes. */
export const barJobId = (j: Pick<BarCloseJob, 'robotId' | 'symbol' | 'barTs'>): string =>
  `bar__${j.robotId}__${j.symbol.replace(/[^A-Za-z0-9._-]/g, '-')}__${j.barTs}`;
