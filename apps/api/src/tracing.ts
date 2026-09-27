// OpenTelemetry bootstrap. Loaded before Nest so http/express/pg get instrumented.
// Enabled when OTEL_EXPORTER_OTLP_ENDPOINT (collector) and/or KORA_OTEL_FILE (JSON lines, tests and
// drills) is set. Outgoing fetch calls (quant) carry W3C trace context via the undici
// instrumentation, so api → quant spans join the caller's trace (goal 10, B-507/B-603).
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { appendFileSync } from 'node:fs';

import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';

import { FileSpanExporter } from './observability/file-span-exporter';

export function startTracing(serviceName = 'kora-api'): NodeSDK | null {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const file = process.env.KORA_OTEL_FILE?.trim();
  if (!endpoint && !file) return null;
  process.env.OTEL_SERVICE_NAME ??= serviceName;
  const spanProcessors: SpanProcessor[] = [];
  if (endpoint) spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
  // Batched: a synchronous write per span would itself slow the request path it measures.
  const fileProcessor = file
    ? new BatchSpanProcessor(new FileSpanExporter(file), {
        scheduledDelayMillis: 500,
        maxQueueSize: 100_000,
        maxExportBatchSize: 5_000,
      })
    : null;
  if (fileProcessor) spanProcessors.push(fileProcessor);
  const sdk = new NodeSDK({
    spanProcessors,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => req.url === '/health' || req.url === '/metrics',
      }),
      new ExpressInstrumentation(),
      new PgInstrumentation(),
      new UndiciInstrumentation(),
    ],
  });
  sdk.start();
  process.once('SIGTERM', () => void sdk.shutdown());
  if (file && fileProcessor) {
    // IRTC R6: tests and drills flush the file exporter on demand (SIGUSR2) and wait for the marker
    // line in `<file>.flush` instead of sleeping past the batch delay. Only with KORA_OTEL_FILE.
    process.on('SIGUSR2', () => {
      void fileProcessor.forceFlush().then(
        () => appendFileSync(`${file}.flush`, `${Date.now()}\n`),
        () => appendFileSync(`${file}.flush`, `error ${Date.now()}\n`),
      );
    });
  }
  return sdk;
}
