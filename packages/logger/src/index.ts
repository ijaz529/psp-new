import pino, { type Logger as PinoLogger, type LoggerOptions as PinoOptions, type Level } from 'pino';
import { PINO_REDACT_PATHS, maskPanDeep } from './redaction.js';

export { assertNoPan, maskPanDeep, maskPanInString, PINO_REDACT_PATHS } from './redaction.js';

export interface LogBindings {
  request_id?: string;
  trace_id?: string;
  span_id?: string;
  merchant_id?: string;
  payment_intent_id?: string;
  [key: string]: unknown;
}

/**
 * The logger interface we expose to apps. Intentionally narrower than Pino's so
 * we can swap implementations later without ripple. Pino is the only impl today.
 */
export interface Logger {
  trace(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object | Error, msg?: string): void;
  fatal(obj: object | Error, msg?: string): void;
  child(bindings: LogBindings): Logger;
  /** Escape hatch: the underlying Pino instance. Use sparingly. */
  readonly raw: PinoLogger;
}

export interface LoggerOptions {
  /** Defaults to env LOG_LEVEL or 'info'. */
  readonly level?: Level;
  /** Defaults to env LOG_PRETTY === 'true' && NODE_ENV !== 'production'. */
  readonly pretty?: boolean;
  /** Service name baked into every record as `service`. */
  readonly service: string;
  /** Static bindings included on every record. */
  readonly base?: Record<string, unknown>;
  /** Override redact paths (append to defaults). */
  readonly extraRedactPaths?: ReadonlyArray<string>;
}

function wrap(p: PinoLogger): Logger {
  return {
    trace: (obj, msg) => p.trace(obj, msg),
    debug: (obj, msg) => p.debug(obj, msg),
    info: (obj, msg) => p.info(obj, msg),
    warn: (obj, msg) => p.warn(obj, msg),
    error: (obj, msg) => {
      if (obj instanceof Error) p.error({ err: obj }, msg ?? obj.message);
      else p.error(obj as object, msg);
    },
    fatal: (obj, msg) => {
      if (obj instanceof Error) p.fatal({ err: obj }, msg ?? obj.message);
      else p.fatal(obj as object, msg);
    },
    child: (bindings) => wrap(p.child(bindings)),
    raw: p,
  };
}

export function createLogger(opts: LoggerOptions): Logger {
  const level: Level = opts.level ?? (process.env.LOG_LEVEL as Level | undefined) ?? 'info';
  const pretty = opts.pretty ?? (process.env.LOG_PRETTY === 'true' && process.env.NODE_ENV !== 'production');

  const redactPaths = [...PINO_REDACT_PATHS, ...(opts.extraRedactPaths ?? [])];

  const pinoOpts: PinoOptions = {
    level,
    base: {
      service: opts.service,
      env: process.env.NODE_ENV ?? 'development',
      ...(opts.base ?? {}),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: redactPaths,
      censor: '[REDACTED]',
    },
    formatters: {
      level(label) {
        return { level: label };
      },
      log(record) {
        // Layer 2: scan every string value for PAN-shaped runs.
        // Mutates `record` in place; Pino is done with it.
        return maskPanDeep(record) as Record<string, unknown>;
      },
    },
    // Avoid surfacing raw `pid`/`hostname` — we already have OTel resource attrs.
    serializers: {
      err: pino.stdSerializers.err,
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
    },
  };

  const logger: PinoLogger = pretty
    ? pino(
        pinoOpts,
        pino.transport({ target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l', singleLine: false } }),
      )
    : pino(pinoOpts);

  return wrap(logger);
}

/** A no-op logger for tests and pure-function call sites that need an injectable. */
export function nullLogger(): Logger {
  const noop = () => undefined;
  const self: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => self,
    raw: pino({ enabled: false }),
  };
  return self;
}
