/**
 * Phase 30 — Cardholder REST API surface.
 *
 * All routes here are scoped on req.cardholderId set by
 * cardholderAuthPlugin. Filter every query on it so no URL can reach
 * another cardholder's data.
 */

import { randomBytes } from 'node:crypto';
import { PspError } from '@psp-new/errors';
import { newId } from '@psp-new/ids';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getCardholderId } from '../../lib/cardholder-auth.js';
import type { AppContext } from '../../lib/context.js';
import { bigintToWire, dateToUnix } from '../../lib/serialize.js';

export function registerCardholder(app: FastifyInstance, ctx: AppContext): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const CFG = { skipApiKey: true, requireCardholderKey: true } as const;

  // ---------------------- /v1/cardholder/me ----------------------
  typed.get('/v1/cardholder/me', {
    config: CFG,
    handler: async (req) => {
      const id = getCardholderId(req);
      const row = await ctx.db
        .selectFrom('paycore.cardholders')
        .select(['id', 'email', 'full_name', 'phone', 'status', 'created_at'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) throw new PspError('resource_missing');
      return {
        id: row.id,
        object: 'cardholder',
        email: row.email,
        full_name: row.full_name,
        phone: row.phone,
        status: row.status,
        created: dateToUnix(row.created_at),
      };
    },
  });

  // ---------------------- /v1/cardholder/cards ----------------------
  typed.get('/v1/cardholder/cards', {
    config: CFG,
    handler: async (req) => {
      const cardholderId = getCardholderId(req);
      const rows = await ctx.db
        .selectFrom('paycore.cards')
        .innerJoin('paycore.card_products', 'paycore.card_products.id', 'paycore.cards.product_id')
        .leftJoin('ledger.account_balances', 'ledger.account_balances.account_id', 'paycore.cards.funded_account_id')
        .select([
          'paycore.cards.id as id',
          'paycore.cards.bin as bin',
          'paycore.cards.last4 as last4',
          'paycore.cards.exp_month as exp_month',
          'paycore.cards.exp_year as exp_year',
          'paycore.cards.status as status',
          'paycore.cards.created_at as created_at',
          'paycore.card_products.id as product_id',
          'paycore.card_products.name as product_name',
          'paycore.card_products.currency as currency',
          'ledger.account_balances.balance as funded_balance',
        ])
        .where('paycore.cards.cardholder_id', '=', cardholderId)
        .orderBy('paycore.cards.created_at', 'desc')
        .execute();
      return {
        object: 'list',
        data: rows.map((r) => ({
          id: r.id,
          object: 'card',
          bin: r.bin,
          last4: r.last4,
          exp_month: r.exp_month,
          exp_year: r.exp_year,
          status: r.status,
          product: { id: r.product_id, name: r.product_name, currency: r.currency },
          available: bigintToWire(((r.funded_balance as bigint | null) ?? 0n) as bigint),
          created: dateToUnix(r.created_at),
        })),
      };
    },
  });

  // ---------------------- /v1/cardholder/cards/:id ----------------------
  typed.get('/v1/cardholder/cards/:id', {
    config: CFG,
    schema: { params: z.object({ id: z.string().regex(/^card_/) }) },
    handler: async (req) => {
      const cardholderId = getCardholderId(req);
      const { id } = req.params as { id: string };
      const card = await ctx.db
        .selectFrom('paycore.cards')
        .innerJoin('paycore.card_products', 'paycore.card_products.id', 'paycore.cards.product_id')
        .select([
          'paycore.cards.id as id',
          'paycore.cards.bin as bin',
          'paycore.cards.last4 as last4',
          'paycore.cards.exp_month as exp_month',
          'paycore.cards.exp_year as exp_year',
          'paycore.cards.status as status',
          'paycore.cards.funded_account_id as funded_account_id',
          'paycore.cards.holds_account_id as holds_account_id',
          'paycore.cards.created_at as created_at',
          'paycore.card_products.name as product_name',
          'paycore.card_products.currency as currency',
        ])
        .where('paycore.cards.id', '=', id)
        .where('paycore.cards.cardholder_id', '=', cardholderId)
        .executeTakeFirst();
      if (!card) throw new PspError('resource_missing');
      const [funded, holds] = await Promise.all([
        ctx.db
          .selectFrom('ledger.account_balances')
          .select('balance')
          .where('account_id', '=', card.funded_account_id)
          .executeTakeFirst(),
        ctx.db
          .selectFrom('ledger.account_balances')
          .select('balance')
          .where('account_id', '=', card.holds_account_id)
          .executeTakeFirst(),
      ]);
      return {
        id: card.id,
        object: 'card',
        bin: card.bin,
        last4: card.last4,
        exp_month: card.exp_month,
        exp_year: card.exp_year,
        status: card.status,
        product: { name: card.product_name, currency: card.currency },
        funded_balance: bigintToWire(((funded as { balance: bigint } | undefined)?.balance ?? 0n) as bigint),
        holds_balance: bigintToWire(((holds as { balance: bigint } | undefined)?.balance ?? 0n) as bigint),
        created: dateToUnix(card.created_at),
      };
    },
  });

  // ---------------------- /v1/cardholder/card_loads ----------------------
  typed.get('/v1/cardholder/card_loads', {
    config: CFG,
    handler: async (req) => {
      const cardholderId = getCardholderId(req);
      const rows = await ctx.db
        .selectFrom('paycore.card_loads')
        .innerJoin('paycore.cards', 'paycore.cards.id', 'paycore.card_loads.card_id')
        .select([
          'paycore.card_loads.id as id',
          'paycore.card_loads.card_id as card_id',
          'paycore.card_loads.amount as amount',
          'paycore.card_loads.currency as currency',
          'paycore.card_loads.status as status',
          'paycore.card_loads.response_code as response_code',
          'paycore.card_loads.rrn as rrn',
          'paycore.card_loads.stan as stan',
          'paycore.card_loads.created_at as created_at',
        ])
        .where('paycore.cards.cardholder_id', '=', cardholderId)
        .orderBy('paycore.card_loads.created_at', 'desc')
        .limit(50)
        .execute();
      return {
        object: 'list',
        data: rows.map((r) => ({
          id: r.id,
          object: 'card_load',
          card: r.card_id,
          amount: bigintToWire(r.amount),
          currency: r.currency,
          status: r.status,
          response_code: r.response_code,
          rrn: r.rrn,
          stan: r.stan,
          created: dateToUnix(r.created_at),
        })),
      };
    },
  });

  // ---------------------- /v1/cardholder/webhook_endpoints ----------------------
  typed.get('/v1/cardholder/webhook_endpoints', {
    config: CFG,
    handler: async (req) => {
      const cardholderId = getCardholderId(req);
      const rows = await ctx.db
        .selectFrom('paycore.webhook_endpoints')
        .select(['id', 'url', 'description', 'status', 'enabled_events', 'created_at'])
        .where('cardholder_id', '=', cardholderId)
        .orderBy('created_at', 'desc')
        .execute();
      return {
        object: 'list',
        data: rows.map((r) => ({
          id: r.id,
          object: 'webhook_endpoint',
          url: r.url,
          description: r.description,
          enabled_events: r.enabled_events,
          status: r.status,
          created: dateToUnix(r.created_at),
        })),
      };
    },
  });

  const NewEndpointBody = z.object({
    url: z.string().url().max(2048),
    enabled_events: z.array(z.string()).optional(),
    description: z.string().max(200).optional(),
  });
  typed.post('/v1/cardholder/webhook_endpoints', {
    config: CFG,
    schema: { body: NewEndpointBody },
    handler: async (req, reply) => {
      const cardholderId = getCardholderId(req);
      const body = req.body as z.infer<typeof NewEndpointBody>;
      const id = newId('webhook_endpoint');
      const secret = `whsec_${randomBytes(32).toString('hex')}`;
      const enabledEvents = body.enabled_events && body.enabled_events.length > 0 ? body.enabled_events : ['*'];
      const created = new Date();
      await ctx.db
        .insertInto('paycore.webhook_endpoints')
        .values({
          id,
          merchant_id: null,
          cardholder_id: cardholderId,
          url: body.url,
          description: body.description ?? null,
          enabled_events: enabledEvents,
          signing_secret: secret,
          status: 'enabled',
          created_at: created,
          disabled_at: null,
        })
        .execute();
      reply.status(201);
      return {
        id,
        object: 'webhook_endpoint',
        url: body.url,
        description: body.description ?? null,
        enabled_events: enabledEvents,
        status: 'enabled',
        secret, // shown ONCE
        created: dateToUnix(created),
      };
    },
  });

  typed.post('/v1/cardholder/webhook_endpoints/:id/disable', {
    config: CFG,
    schema: { params: z.object({ id: z.string().regex(/^we_/) }) },
    handler: async (req) => {
      const cardholderId = getCardholderId(req);
      const { id } = req.params as { id: string };
      const r = await ctx.db
        .updateTable('paycore.webhook_endpoints')
        .set({ status: 'disabled', disabled_at: new Date() })
        .where('id', '=', id)
        .where('cardholder_id', '=', cardholderId)
        .where('status', '=', 'enabled')
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) {
        throw new PspError('payment_intent_unexpected_state', {
          message: 'endpoint not enabled or not found',
        });
      }
      return { id, object: 'webhook_endpoint', status: 'disabled' };
    },
  });
}
