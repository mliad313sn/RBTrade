import {
  context,
  propagation,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
} from '@opentelemetry/api';

const tracer = () => trace.getTracer('kora-api');

/**
 * Runs `fn` inside a child span of the active context (or of `parent`). A no-op tracer is used when
 * tracing is not started, so the cost on the order path is a function call.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => Promise<T>,
  parent?: Context,
): Promise<T> {
  return tracer().startActiveSpan(
    name,
    { attributes },
    parent ?? context.active(),
    async (span) => {
      try {
        return await fn();
      } catch (e) {
        span.recordException(e as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
        throw e;
      } finally {
        span.end();
      }
    },
  );
}

/** W3C traceparent of the active span, stored with an order so the asynchronous fill joins its trace. */
export function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

/** Context whose parent is the stored traceparent (or the active context when there is none). */
export function contextFrom(traceparent: string | null | undefined): Context {
  if (!traceparent) return context.active();
  return propagation.extract(context.active(), { traceparent });
}
