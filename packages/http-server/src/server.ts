import fastifySwagger from '@fastify/swagger';
import { PspError, isPspError } from '@psp-new/errors';
import { newId } from '@psp-new/ids';
import { type Logger, createLogger } from '@psp-new/logger';
import { activeTraceContext } from '@psp-new/otel';
import Fastify, { type FastifyInstance } from 'fastify';
import { type ZodTypeProvider, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import {
  bootstrapMetrics,
  canaryRequestsTotal,
  httpRequestDurationSeconds,
  httpRequestsTotal,
  metricsRegister,
  statusClass,
} from './metrics.js';

export interface HttpServerOptions {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  /** Logger; if omitted, a default is built from env. */
  readonly logger?: Logger;
  /** Disable OpenAPI plugin (e.g. for the vault, which is not public). */
  readonly disableOpenApi?: boolean;
  /** Title shown in the OpenAPI document. */
  readonly openApiTitle?: string;
  /** Readiness dependencies — return false to fail /readyz. */
  readonly readinessChecks?: ReadonlyArray<{ name: string; check: () => Promise<boolean> }>;
  /** Inject a clock for tests. */
  readonly now?: () => number;
}

export type PspFastifyInstance = FastifyInstance & {
  withTypeProvider: () => FastifyInstance;
};

/**
 * Build a fully-wired Fastify instance. The caller adds business routes via
 * `app.register(...)` and starts it via `await app.listen(...)`.
 *
 *   - Request ids:   X-Request-Id propagated; `req_<ulid>` minted if absent.
 *   - Validation:    zod via fastify-type-provider-zod.
 *   - Logging:       Pino with PCI redaction at the source.
 *   - Tracing:       OTel auto-instrumentation (init separately via preload).
 *   - Errors:        PspError → Stripe-style envelope; unknown → internal_error 500.
 *   - Endpoints:     /healthz, /readyz, /metrics — always mounted.
 *   - OpenAPI:       /openapi.json — generated from zod schemas (unless disabled).
 */
export async function createHttpServer(opts: HttpServerOptions): Promise<FastifyInstance> {
  const logger = opts.logger ?? createLogger({ service: opts.serviceName });

  bootstrapMetrics(opts.serviceName);

  const app = Fastify({
    loggerInstance: logger.raw,
    disableRequestLogging: false,
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'request_id',
    genReqId: () => newId('request'),
    trustProxy: false,
    bodyLimit: 1_048_576, // 1 MiB default; raise per-route if needed.
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // Add the X-Request-Id response header so merchants can quote it.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    // Bind trace context to the request logger so every log line in this handler
    // carries trace_id/span_id without explicit threading.
    const ctx = activeTraceContext();
    if (ctx.trace_id) {
      (req as { log: typeof req.log }).log = req.log.child({ trace_id: ctx.trace_id, span_id: ctx.span_id });
    }
  });

  // Capture the start time for the RED histogram.
  const startTimes = new WeakMap<object, number>();
  const nowMs = opts.now ?? (() => performance.now());

  app.addHook('onRequest', async (req) => {
    startTimes.set(req, nowMs());
  });

  app.addHook('onResponse', async (req, reply) => {
    const start = startTimes.get(req);
    const route = (req.routeOptions?.url as string | undefined) ?? req.url;
    const labels = { route, method: req.method, status_class: statusClass(reply.statusCode) };
    httpRequestsTotal.inc(labels);
    if (start !== undefined) {
      httpRequestDurationSeconds.observe(labels, (nowMs() - start) / 1000);
    }
  });

  // Centralized error handler — converts PspError into the Stripe-shape envelope,
  // and unknown errors into a stable internal_error 500 with the request_id logged.
  app.setErrorHandler((rawErr, req, reply) => {
    const err = rawErr as Error & { validation?: unknown };
    if (isPspError(err)) {
      req.log.warn({ err, code: err.code, category: err.category, internal: err.internal }, 'psp error');
      reply.status(err.httpStatus).send(err.toWireEnvelope(req.id));
      return;
    }
    // zod validation errors come with a `validation` property
    if (err.validation) {
      const pe = new PspError('parameter_invalid', {
        message: err.message,
        internal: { validation: err.validation },
      });
      reply.status(pe.httpStatus).send(pe.toWireEnvelope(req.id));
      return;
    }
    req.log.error({ err }, 'unhandled error');
    const fallback = new PspError('internal_error', { internal: { name: err.name, message: err.message } });
    reply.status(fallback.httpStatus).send(fallback.toWireEnvelope(req.id));
  });

  // ------------------------------- platform routes -------------------------------

  app.get('/healthz', async () => {
    canaryRequestsTotal.inc({ service: opts.serviceName });
    return { status: 'ok', service: opts.serviceName, version: opts.serviceVersion ?? '0.0.0' };
  });

  app.get('/readyz', async (_req, reply) => {
    const results: Record<string, boolean> = {};
    let allOk = true;
    for (const c of opts.readinessChecks ?? []) {
      try {
        const ok = await c.check();
        results[c.name] = ok;
        if (!ok) allOk = false;
      } catch {
        results[c.name] = false;
        allOk = false;
      }
    }
    if (!allOk) reply.status(503);
    return { status: allOk ? 'ready' : 'not_ready', checks: results };
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', metricsRegister.contentType);
    return await metricsRegister.metrics();
  });

  // ------------------------------- OpenAPI ---------------------------------------

  if (!opts.disableOpenApi) {
    await app.register(fastifySwagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: opts.openApiTitle ?? `${opts.serviceName} API`,
          version: opts.serviceVersion ?? '0.0.0',
        },
      },
    });
    app.get('/openapi.json', async () => app.swagger());
  }

  // ------------------------------- API version header ----------------------------

  app.addHook('onRequest', async (req, reply) => {
    const v = req.headers['paycore-version'];
    const value = Array.isArray(v) ? v[0] : v;
    if (value && value !== 'latest' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new PspError('unsupported_api_version', { param: 'PayCore-Version' });
    }
    reply.header('paycore-version', value ?? 'latest');
  });

  return typed as unknown as FastifyInstance;
}
