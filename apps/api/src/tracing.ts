// OpenTelemetry bootstrap. Loaded before Nest so http/express/pg get instrumented.
// Disabled unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { NodeSDK } from '@opentelemetry/sdk-node';

export function startTracing(serviceName = 'kora-api'): NodeSDK | null {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return null;
  process.env.OTEL_SERVICE_NAME ??= serviceName;
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation(), new PgInstrumentation()],
  });
  sdk.start();
  process.once('SIGTERM', () => void sdk.shutdown());
  return sdk;
}
