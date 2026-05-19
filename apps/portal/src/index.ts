import fastifyFormbody from '@fastify/formbody';
import { generateApiKey } from '@psp-new/api-keys';
import { createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';
import { createHttpServer } from '@psp-new/http-server';
import { newId } from '@psp-new/ids';
import { createLogger } from '@psp-new/logger';
import { initTelemetry } from '@psp-new/otel';
import {
  buildClearCookie,
  buildSetCookie,
  createSession,
  readSessionCookie,
  resolveSession,
  revokeSession,
  verifyPassword,
} from '@psp-new/portal-auth';
import { z } from 'zod';
import { cardDetailPage, cardsListPage } from './cards-views.js';
import { dashboardPage, merchantDetailPage, merchantsListPage, signInPage } from './dashboard-views.js';
import { createdPage, signUpPage } from './views.js';

const SignUpBody = z.object({
  name: z.string().min(2).max(120),
  env: z.enum(['test', 'live']),
});
const SignInBody = z.object({ email: z.string().email(), password: z.string().min(8) });
const KybBody = z.object({
  legal_name: z.string().min(1).max(256),
  country: z.string().length(2),
  tax_id: z.string().min(1).max(64),
  mcc: z.string().regex(/^\d{4}$/),
  notes: z.string().max(2000).optional(),
});

async function main(): Promise<void> {
  const shutdownOtel = await initTelemetry({ serviceName: 'portal' });
  const logger = createLogger({ service: 'portal' });

  const pool = createPool({ ...dbConfigFromEnv(), applicationName: 'portal' });
  const db = createKysely(pool);

  const app = await createHttpServer({
    serviceName: 'portal',
    logger,
    disableOpenApi: true,
    readinessChecks: [{ name: 'postgres', check: async () => (await pool.query('select 1')) && true }],
  });

  await app.register(fastifyFormbody);

  // ---------------------------------------------------------------
  // Session resolver: every non-public route hits this preHandler.
  // ---------------------------------------------------------------
  const PUBLIC_PATHS = new Set(['/', '/sign-up', '/signin', '/healthz', '/readyz', '/metrics']);
  app.addHook('preHandler', async (req, reply) => {
    if (PUBLIC_PATHS.has(req.url) || req.url.startsWith('/metrics')) return;
    const cookie = readSessionCookie(req.headers.cookie);
    if (!cookie) {
      reply.redirect('/signin', 302);
      return;
    }
    const r = await resolveSession(db, cookie);
    if (!r) {
      reply.header('set-cookie', buildClearCookie()).redirect('/signin', 302);
      return;
    }
    (req as { portalUser?: typeof r.user; sessionId?: string }).portalUser = r.user;
    (req as { sessionId?: string }).sessionId = r.sessionId;
  });

  // ---------------------------------------------------------------
  // Phase 3 sign-up flow (kept). Phase 8 adds auth + dashboard.
  // ---------------------------------------------------------------
  app.get('/', async (_req, reply) => {
    reply.type('text/html');
    return signUpPage();
  });
  app.post('/sign-up', async (req, reply) => {
    const parsed = SignUpBody.safeParse(req.body);
    if (!parsed.success) {
      reply.type('text/html').status(400);
      return signUpPage(parsed.error.issues[0]?.message ?? 'invalid input');
    }
    const { name, env } = parsed.data;
    const merchantId = newId('merchant');
    const pk = generateApiKey({ kind: 'publishable', env });
    const sk = generateApiKey({ kind: 'secret', env });
    const allowedOrigins = ['http://localhost:3000', 'http://localhost:7001', 'http://localhost:8080'];
    const now = new Date();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('paycore.merchants')
        .values({
          id: merchantId,
          name,
          env,
          allowed_origins: allowedOrigins,
          reserve_basis_points: 0,
          payout_schedule: 'daily',
          kyb_status: 'pending',
          kyb_data: null,
          created_at: now,
        })
        .execute();
      await trx
        .insertInto('paycore.api_keys')
        .values([
          {
            id: pk.id,
            merchant_id: merchantId,
            kind: 'publishable',
            env,
            prefix: pk.prefix,
            sha256_hash: pk.sha256Hash,
            created_at: now,
            last_used_at: null,
            revoked_at: null,
          },
          {
            id: sk.id,
            merchant_id: merchantId,
            kind: 'secret',
            env,
            prefix: sk.prefix,
            sha256_hash: sk.sha256Hash,
            created_at: now,
            last_used_at: null,
            revoked_at: null,
          },
        ])
        .execute();
    });
    reply.type('text/html');
    return createdPage({ merchantId, name, env, publishableKey: pk.raw, secretKey: sk.raw });
  });

  // ---------------------------------------------------------------
  // Auth — sign in / sign out
  // ---------------------------------------------------------------
  app.get('/signin', async (_req, reply) => {
    reply.type('text/html');
    return signInPage();
  });
  app.post('/signin', async (req, reply) => {
    const parsed = SignInBody.safeParse(req.body);
    if (!parsed.success) {
      reply.type('text/html').status(400);
      return signInPage('email + password required');
    }
    const user = await db
      .selectFrom('paycore.portal_users')
      .selectAll()
      .where('email', '=', parsed.data.email)
      .executeTakeFirst();
    if (!user || user.disabled_at || !verifyPassword(parsed.data.password, user.password_hash)) {
      reply.type('text/html').status(401);
      return signInPage('invalid email or password');
    }
    const session = await createSession(db, user.id);
    await db.updateTable('paycore.portal_users').set({ last_login_at: new Date() }).where('id', '=', user.id).execute();
    reply.header('set-cookie', buildSetCookie(session.token)).redirect('/dashboard', 302);
  });
  app.get('/signout', async (req, reply) => {
    const sessionId = (req as { sessionId?: string }).sessionId;
    if (sessionId) await revokeSession(db, sessionId);
    reply.header('set-cookie', buildClearCookie()).redirect('/signin', 302);
  });

  // ---------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------
  app.get('/dashboard', async (req, reply) => {
    const user = requireUser(req);
    const [{ count: merchantCount }, txs, pys, dps] = await Promise.all([
      db
        .selectFrom('paycore.merchants')
        .select((eb) => eb.fn.countAll<bigint>().as('count'))
        .executeTakeFirstOrThrow(),
      db.selectFrom('paycore.payment_intents').selectAll().orderBy('created_at', 'desc').limit(10).execute(),
      db.selectFrom('paycore.payouts').selectAll().orderBy('created_at', 'desc').limit(10).execute(),
      db.selectFrom('paycore.disputes').selectAll().orderBy('created_at', 'desc').limit(10).execute(),
    ]);
    reply.type('text/html');
    return dashboardPage({
      user: user.display_name,
      merchantCount: Number(merchantCount ?? 0),
      recentTransactions: txs.map((t) => ({
        id: t.id,
        merchant: t.merchant_id,
        amount: t.amount,
        currency: t.currency,
        status: t.status,
        created: t.created_at,
      })),
      recentPayouts: pys.map((p) => ({
        id: p.id,
        merchant: p.merchant_id,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        scheduled: p.scheduled_for,
      })),
      recentDisputes: dps.map((d) => ({
        id: d.id,
        merchant: d.merchant_id,
        state: d.state,
        reason: d.reason_code,
        created: d.created_at,
      })),
    });
  });

  app.get('/merchants', async (req, reply) => {
    const user = requireUser(req);
    const rows = await db.selectFrom('paycore.merchants').selectAll().orderBy('created_at', 'desc').execute();
    reply.type('text/html');
    return merchantsListPage({
      user: user.display_name,
      merchants: rows.map((m) => ({
        id: m.id,
        name: m.name,
        env: m.env,
        kyb_status: m.kyb_status,
        created: m.created_at,
      })),
    });
  });

  app.get('/merchants/:id', async (req, reply) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const m = await db.selectFrom('paycore.merchants').selectAll().where('id', '=', id).executeTakeFirst();
    if (!m) {
      reply.status(404).type('text/html');
      return signInPage('merchant not found');
    }
    const [apiKeys, webhooks, txs] = await Promise.all([
      db
        .selectFrom('paycore.api_keys')
        .select(['kind', 'prefix', 'last_used_at', 'revoked_at'])
        .where('merchant_id', '=', id)
        .orderBy('created_at', 'desc')
        .execute(),
      db
        .selectFrom('paycore.webhook_endpoints')
        .select(['id', 'url', 'status'])
        .where('merchant_id', '=', id)
        .where('status', '!=', 'deleted')
        .execute(),
      db
        .selectFrom('paycore.payment_intents')
        .selectAll()
        .where('merchant_id', '=', id)
        .orderBy('created_at', 'desc')
        .limit(10)
        .execute(),
    ]);
    reply.type('text/html');
    return merchantDetailPage({
      user: user.display_name,
      merchant: {
        id: m.id,
        name: m.name,
        env: m.env,
        kyb_status: m.kyb_status,
        allowed_origins: m.allowed_origins,
        reserve_basis_points: m.reserve_basis_points,
      },
      apiKeys,
      webhooks,
      recentTransactions: txs.map((t) => ({
        id: t.id,
        amount: t.amount,
        currency: t.currency,
        status: t.status,
        created: t.created_at,
      })),
    });
  });

  // ---------------------------------------------------------------
  // Phase 12 — Cards
  // ---------------------------------------------------------------
  app.get('/cards', async (req, reply) => {
    const user = requireUser(req);
    const rows = await db
      .selectFrom('paycore.cards')
      .innerJoin('paycore.cardholders', 'paycore.cardholders.id', 'paycore.cards.cardholder_id')
      .innerJoin('paycore.card_products', 'paycore.card_products.id', 'paycore.cards.product_id')
      .leftJoin('ledger.account_balances', 'ledger.account_balances.account_id', 'paycore.cards.funded_account_id')
      .select([
        'paycore.cards.id as id',
        'paycore.cards.bin as bin',
        'paycore.cards.last4 as last4',
        'paycore.cards.status as status',
        'paycore.card_products.currency as currency',
        'paycore.card_products.name as product_name',
        'paycore.cardholders.email as email',
        'paycore.cardholders.full_name as full_name',
        'ledger.account_balances.balance as funded_balance',
      ])
      .orderBy('paycore.cards.created_at', 'desc')
      .limit(200)
      .execute();
    reply.type('text/html');
    return cardsListPage({
      user: user.display_name,
      cards: rows.map((r) => ({
        id: r.id,
        bin: r.bin,
        last4: r.last4,
        status: r.status,
        currency: r.currency,
        cardholderEmail: r.email,
        cardholderName: r.full_name,
        productName: r.product_name,
        fundedBalance: (r.funded_balance as bigint | null) ?? 0n,
      })),
    });
  });

  app.get('/cards/:id', async (req, reply) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const card = await db
      .selectFrom('paycore.cards')
      .innerJoin('paycore.cardholders', 'paycore.cardholders.id', 'paycore.cards.cardholder_id')
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
        'paycore.cardholders.id as cardholder_id',
        'paycore.cardholders.email as email',
        'paycore.cardholders.full_name as full_name',
        'paycore.card_products.id as product_id',
        'paycore.card_products.name as product_name',
        'paycore.card_products.currency as currency',
      ])
      .where('paycore.cards.id', '=', id)
      .executeTakeFirst();
    if (!card) {
      reply.status(404).type('text/html');
      return signInPage('card not found');
    }
    const [funded, holds, loads, authHolds] = await Promise.all([
      db
        .selectFrom('ledger.account_balances')
        .select('balance')
        .where('account_id', '=', card.funded_account_id)
        .executeTakeFirst(),
      db
        .selectFrom('ledger.account_balances')
        .select('balance')
        .where('account_id', '=', card.holds_account_id)
        .executeTakeFirst(),
      db
        .selectFrom('paycore.card_loads')
        .selectAll()
        .where('card_id', '=', id)
        .orderBy('created_at', 'desc')
        .limit(20)
        .execute(),
      db
        .selectFrom('paycore.card_auth_holds')
        .selectAll()
        .where('card_id', '=', id)
        .orderBy('created_at', 'desc')
        .limit(20)
        .execute(),
    ]);
    reply.type('text/html');
    return cardDetailPage({
      user: user.display_name,
      card: {
        id: card.id,
        bin: card.bin,
        last4: card.last4,
        expMonth: card.exp_month,
        expYear: card.exp_year,
        status: card.status,
        currency: card.currency,
        productName: card.product_name,
        productId: card.product_id,
        cardholderId: card.cardholder_id,
        cardholderEmail: card.email,
        cardholderName: card.full_name,
        fundedAccountId: card.funded_account_id,
        holdsAccountId: card.holds_account_id,
        fundedBalance: ((funded as { balance: bigint } | undefined)?.balance ?? 0n) as bigint,
        holdsBalance: ((holds as { balance: bigint } | undefined)?.balance ?? 0n) as bigint,
      },
      loads: loads.map((l) => ({
        id: l.id,
        amount: l.amount,
        currency: l.currency,
        status: l.status,
        responseCode: l.response_code,
        rrn: l.rrn,
        stan: l.stan,
        failureCode: l.failure_code,
        created: l.created_at,
      })),
      authHolds: authHolds.map((h) => ({
        id: h.id,
        amount: h.amount,
        currency: h.currency,
        stan: h.stan,
        rrn: h.rrn,
        mcc: h.mcc,
        merchantName: h.merchant_name,
        approvalCode: h.approval_code,
        resolvedReason: h.resolved_reason,
        resolvedAt: h.resolved_at,
        created: h.created_at,
      })),
    });
  });

  app.post('/merchants/:id/kyb', async (req, reply) => {
    requireUser(req);
    const { id } = req.params as { id: string };
    const parsed = KybBody.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: parsed.error.issues[0]?.message };
    }
    await db
      .updateTable('paycore.merchants')
      .set({ kyb_status: 'submitted', kyb_data: parsed.data })
      .where('id', '=', id)
      .execute();
    reply.redirect(`/merchants/${id}`, 302);
  });

  app.addHook('onClose', async () => {
    await pool.end();
  });

  const port = Number.parseInt(process.env.PORTAL_PORT ?? '3000', 10);
  await app.listen({ port, host: '0.0.0.0' });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      await shutdownOtel();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function requireUser(req: unknown): { display_name: string } {
  const u = (req as { portalUser?: { display_name: string } }).portalUser;
  if (!u) throw new Error('preHandler should have redirected');
  return u;
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('portal failed to start', err);
  process.exit(1);
});
