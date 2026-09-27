import { appendFileSync } from 'node:fs';

import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

const hrMs = (t: [number, number]) => t[0] * 1000 + t[1] / 1e6;

/** One JSON line per finished span, for the service's trace name and the span's own identifiers. */
export function spanToJson(s: ReadableSpan): Record<string, unknown> {
  const ctx = s.spanContext();
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: s.parentSpanContext?.spanId ?? null,
    name: s.name,
    kind: s.kind,
    service: s.resource.attributes['service.name'] ?? null,
    startMs: hrMs(s.startTime),
    durationMs: hrMs(s.duration),
    status: s.status.code,
    attributes: s.attributes,
    links: s.links.map((l) => ({ traceId: l.context.traceId, spanId: l.context.spanId })),
  };
}

/**
 * Span exporter that appends JSON lines to a file (goal 10). Used by tests and the chaos/load
 * harnesses to prove a trace end to end without a collector (`KORA_OTEL_FILE`). Production uses
 * OTLP to the collector (`OTEL_EXPORTER_OTLP_ENDPOINT`).
 */
export class FileSpanExporter implements SpanExporter {
  constructor(private readonly path: string) {}

  export(spans: ReadableSpan[], done: (r: ExportResult) => void): void {
    try {
      appendFileSync(this.path, spans.map((s) => `${JSON.stringify(spanToJson(s))}\n`).join(''));
      done({ code: 0 });
    } catch (error) {
      done({ code: 1, error: error as Error });
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
