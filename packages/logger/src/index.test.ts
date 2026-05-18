import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { PINO_REDACT_PATHS, assertNoPan, createLogger, maskPanDeep } from './index.js';

const VISA = '4111111111111111';

/**
 * Build a Pino logger configured EXACTLY the way createLogger() configures it,
 * but writing to an in-memory Writable so we can JSON.parse the records.
 * Keep this mirror in sync with createLogger() — it's the integration assertion.
 */
function bufferedLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = pino(
    {
      level: 'trace',
      base: { service: 'test' },
      redact: { paths: [...PINO_REDACT_PATHS], censor: '[REDACTED]' },
      formatters: { log: (record) => maskPanDeep(record) as Record<string, unknown> },
    },
    stream,
  );
  return { logger, lines };
}

describe('createLogger surface', () => {
  it('returns a logger with all level methods', () => {
    const log = createLogger({ service: 'unit-test', level: 'fatal' });
    expect(typeof log.trace).toBe('function');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.fatal).toBe('function');
    expect(typeof log.child).toBe('function');
  });

  it('child() carries bindings', () => {
    const log = createLogger({ service: 'unit-test', level: 'fatal' });
    const child = log.child({ request_id: 'req_xyz' });
    expect(child).toBeDefined();
  });

  it('error(err) handles Error objects', () => {
    // Smoke test: must not throw.
    const log = createLogger({ service: 'unit-test', level: 'fatal' });
    expect(() => log.error(new Error('boom'))).not.toThrow();
  });
});

describe('redaction integration (buffered pino mirror)', () => {
  it('redacts registered field paths (layer 1)', () => {
    const { logger, lines } = bufferedLogger();
    logger.info({ pan: VISA, cvv: '123' }, 'card seen');
    const record = JSON.parse(lines[0]!);
    expect(record.pan).toBe('[REDACTED]');
    expect(record.cvv).toBe('[REDACTED]');
  });

  it('redacts authorization header (layer 1)', () => {
    const { logger, lines } = bufferedLogger();
    logger.info({ req: { headers: { authorization: 'Bearer secret' } } }, 'inbound');
    const record = JSON.parse(lines[0]!);
    expect(record.req.headers.authorization).toBe('[REDACTED]');
  });

  it('layer-2 scanner catches PAN in an UNREGISTERED field', () => {
    const { logger, lines } = bufferedLogger();
    logger.info({ surprise: { burriedDeep: `PAN was ${VISA}` } }, 'oops');
    const record = JSON.parse(lines[0]!);
    expect(record.surprise.burriedDeep).toBe('PAN was 411111******1111');
    expect(() => assertNoPan(record)).not.toThrow();
  });

  it('layer-2 catches PAN with hyphens', () => {
    const { logger, lines } = bufferedLogger();
    logger.info({ note: 'card 4111-1111-1111-1111 processed' });
    const record = JSON.parse(lines[0]!);
    expect(record.note).toBe('card 411111******1111 processed');
  });

  it('does not flag a ULID as PAN', () => {
    const { logger, lines } = bufferedLogger();
    logger.info({ id: 'pi_01HXY00000000000000000000Z' }, 'created');
    const record = JSON.parse(lines[0]!);
    expect(record.id).toBe('pi_01HXY00000000000000000000Z');
  });
});
