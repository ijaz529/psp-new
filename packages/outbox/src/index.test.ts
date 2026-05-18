import { describe, expect, it, vi } from 'vitest';
import { publish } from './index.js';

describe('publish (unit, mocked Kysely)', () => {
  it('inserts an outbox row inside the passed trx with expected shape', async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const values = vi.fn().mockReturnValue({ execute });
    const insertInto = vi.fn().mockReturnValue({ values });
    const trx = { insertInto } as unknown as Parameters<typeof publish>[0];

    const result = await publish(trx, {
      eventType: 'payment_intent.succeeded',
      payload: { id: 'pi_123' },
      resourceId: 'pi_123',
      headers: { trace_id: 'abc' },
    });

    expect(insertInto).toHaveBeenCalledWith('paycore.outbox');
    expect(values).toHaveBeenCalledTimes(1);
    const inserted = values.mock.calls[0]![0];
    expect(inserted.event_type).toBe('payment_intent.succeeded');
    expect(inserted.payload).toEqual({ id: 'pi_123' });
    expect(inserted.resource_id).toBe('pi_123');
    expect(inserted.headers).toEqual({ trace_id: 'abc' });
    expect(inserted.id).toMatch(/^oe_/);
    expect(inserted.attempts).toBe(0);
    expect(inserted.delivered_at).toBeNull();
    expect(inserted.locked_at).toBeNull();
    expect(result.eventType).toBe('payment_intent.succeeded');
    expect(result.id.startsWith('oe_')).toBe(true);
  });

  it('defaults resource_id and headers to null when omitted', async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const values = vi.fn().mockReturnValue({ execute });
    const insertInto = vi.fn().mockReturnValue({ values });
    const trx = { insertInto } as unknown as Parameters<typeof publish>[0];

    await publish(trx, { eventType: 'thing.happened', payload: {} });
    const inserted = values.mock.calls[0]![0];
    expect(inserted.resource_id).toBeNull();
    expect(inserted.headers).toBeNull();
  });
});
