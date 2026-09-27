// OpenTelemetry for the bot runner (goal 10, B-603). Every bar-close job runs in a
// `runner.bar_close` span; fetch calls to the api and quant carry W3C trace context (undici
// instrumentation), so runner → api → quant is one trace. Enabled by OTEL_EXPORTER_OTLP_ENDPOINT
// (collector) and/or KORA_OTEL_FILE (JSON lines, tests and drills).
import { appendFileSync } from 'node:fs';

import { context, SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

const hrMs = (t: [number, number]) => t[0] * 1000 + t[1] / 1e6;

class FileSpanExporter implements SpanExporter {
  constructor(private readonly path: string) {}
  export(spans: ReadableSpan[], done: (r: ExportResult) => void): void {
    try {
      appendFileSync(
        this.path,
        spans
          .map((s) =>
            JSON.stringify({
              traceId: s.spanContext().traceId,
              spanId: s.spanContext().spanId,
              parentSpanId: s.parentSpanContext?.spanId ?? null,
              name: s.name,
              kind: s.kind,
              service: s.resource.attributes['service.name'] ?? null,
              startMs: hrMs(s.startTime),
              durationMs: hrMs(s.duration),
              status: s.status.code,
              attributes: s.attributes,
            }),
          )
          .map((l) => `${l}\n`)
          .join(''),
      );
      done({ code: 0 });
    } catch (error) {
      done({ code: 1, error: error as Error });
    }
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export function startTracing(): NodeSDK | null {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const file = process.env.KORA_OTEL_FILE?.trim();
  if (!endpoint && !file) return null;
  process.env.OTEL_SERVICE_NAME ??= 'kora-bot-runner';
  const spanProcessors: SpanProcessor[] = [];
  if (endpoint) spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
  if (file) spanProcessors.push(new SimpleSpanProcessor(new FileSpanExporter(file)));
  const sdk = new NodeSDK({ spanProcessors, instrumentations: [new UndiciInstrumentation()] });
  sdk.start();
  return sdk;
}

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => Promise<T>,
): Promise<T> {
  return trace
    .getTracer('kora-bot-runner')
    .startActiveSpan(name, { attributes }, context.active(), async (span) => {
      try {
        return await fn();
      } catch (e) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
        throw e;
      } finally {
        span.end();
      }
    });
}
