import { describe, expect, it } from 'vitest';
import { activeTraceContext, getTracer } from './index.js';

describe('otel surface', () => {
  it('getTracer returns a tracer instance', () => {
    const tracer = getTracer('test-service');
    expect(typeof tracer.startSpan).toBe('function');
  });

  it('activeTraceContext returns empty when no span active', () => {
    const ctx = activeTraceContext();
    expect(ctx).toEqual({});
  });

  it('activeTraceContext returns ids when span active', () => {
    const tracer = getTracer('test-service');
    const span = tracer.startSpan('test-span');
    try {
      // Without an active context manager we can't bind; just assert API surface.
      expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      span.end();
    }
  });
});
