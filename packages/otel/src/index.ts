import { type Tracer, context, propagation, trace } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions/incubating';

export { trace, context, propagation };

export interface InitTelemetryOptions {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly otlpEndpoint?: string;
  readonly environment?: string;
}

let sdk: NodeSDK | null = null;

/**
 * Idempotent. Must be called before any other library is imported in app entrypoints
 * (or via --import preload), otherwise auto-instrumentation will miss spans.
 *
 * Returns a `shutdown()` you can register on SIGTERM.
 */
export async function initTelemetry(opts: InitTelemetryOptions): Promise<() => Promise<void>> {
  if (sdk) {
    return async () => {
      /* already initialized; previous shutdown still applies */
    };
  }

  const endpoint = opts.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: opts.serviceName,
    [ATTR_SERVICE_NAMESPACE]: process.env.OTEL_SERVICE_NAMESPACE ?? 'psp-new',
    [ATTR_SERVICE_VERSION]: opts.serviceVersion ?? process.env.npm_package_version ?? '0.0.0',
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: opts.environment ?? process.env.NODE_ENV ?? 'development',
  });

  sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 15_000,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Fastify/HTTP/pg/redis/ioredis are on by default. Disable fs to keep traces quiet.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();

  return async () => {
    if (!sdk) return;
    await sdk.shutdown();
    sdk = null;
  };
}

export function getTracer(serviceName: string, version?: string): Tracer {
  return trace.getTracer(serviceName, version);
}

/** Active trace_id / span_id for log binding. */
export function activeTraceContext(): { trace_id?: string; span_id?: string } {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const ctx = span.spanContext();
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}
