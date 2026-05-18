/**
 * Designed to be used with `node --import @psp-new/otel/preload` (or with tsx in dev).
 * Reads service name from OTEL_SERVICE_NAME env. If absent, throws — set it explicitly
 * in each app's compose/start command so traces are properly attributed.
 */
import { initTelemetry } from './index.js';

const serviceName = process.env.OTEL_SERVICE_NAME;
if (!serviceName) {
  // eslint-disable-next-line no-console
  console.error('[otel/preload] OTEL_SERVICE_NAME is required when using this preload.');
  process.exit(1);
}

await initTelemetry({ serviceName });
