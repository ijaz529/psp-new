import { Counter, Histogram, collectDefaultMetrics, register } from 'prom-client';

export const metricsRegister = register;

let bootstrapped = false;

/**
 * Wire default Node process metrics + our app-level metrics. Safe to call once
 * per process; subsequent calls return the same Registry.
 */
export function bootstrapMetrics(serviceName: string): typeof register {
  if (bootstrapped) return register;
  register.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register });
  bootstrapped = true;
  return register;
}

/**
 * RED metrics: Requests (count), Errors (count), Duration (histogram).
 * Cardinality kept low: { route, method, status_class } only.
 */
export const httpRequestsTotal = new Counter({
  name: 'psp_http_requests_total',
  help: 'HTTP requests handled',
  labelNames: ['route', 'method', 'status_class'] as const,
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'psp_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['route', 'method', 'status_class'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

/** Canary counter for Phase 0 deliverable §I.2 (visible in Grafana). */
export const canaryRequestsTotal = new Counter({
  name: 'psp_canary_healthz_requests_total',
  help: 'Healthz hits — Phase 0 canary metric.',
  labelNames: ['service'] as const,
});

export function statusClass(status: number): string {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  if (status >= 200) return '2xx';
  return '1xx';
}
