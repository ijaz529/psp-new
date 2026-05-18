import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Phase 4: Simulated ACS challenge UI + callback to the api.
 *
 *   GET  /3ds/challenge/:sessionId         — render the OTP page
 *   POST /3ds/complete/:sessionId          — submit Approve/Decline, callback to api
 *
 * The api drives the rest. Phase 5 will replace the api-side stub acquirer
 * with real ISO 8583 forwarding; this 3DS surface keeps its contract.
 */

export interface ThreeDsRoutesDeps {
  /** Where to POST the 3DS result. Defaults to env API_BASE_URL + /v1/_internal/three_ds/callback. */
  readonly apiCallbackUrl?: string;
  /** Inject for tests. */
  readonly fetchImpl?: typeof fetch;
}

const PAGE_CSS = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         background: #f4f6f8; max-width: 480px; margin: 4rem auto; padding: 0 2rem; color: #1a1a1a; }
  .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  h1 { margin: 0 0 0.25rem; font-size: 1.25rem; font-weight: 600; }
  p.muted { color: #777; margin: 0 0 1.5rem; font-size: 0.875rem; }
  .session { font-family: ui-monospace, monospace; font-size: 0.75rem; background: #f0f0f0;
             padding: 0.5rem; border-radius: 4px; word-break: break-all; }
  .otp { font-size: 2rem; font-weight: 600; letter-spacing: 0.5rem; text-align: center;
         margin: 1.5rem 0; background: #e6f0ff; padding: 1rem; border-radius: 8px;
         font-family: ui-monospace, monospace; color: #003a99; }
  .actions { display: flex; gap: 0.75rem; margin-top: 1rem; }
  button { flex: 1; padding: 0.75rem; border: 0; border-radius: 6px; font-size: 1rem;
           cursor: pointer; font-weight: 500; }
  button.approve { background: #1a7f37; color: white; }
  button.approve:hover { background: #1f8f3f; }
  button.decline { background: #cf222e; color: white; }
  button.decline:hover { background: #e83a45; }
  button.attempted { background: #d4a017; color: white; }
  .note { font-size: 0.75rem; color: #888; margin-top: 1rem; text-align: center; }
`;

function challengePage(sessionId: string): string {
  // Synthetic OTP for the demo — would be issued by the issuer for real.
  const otp = String(Math.floor(100_000 + Math.random() * 900_000));
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>3DS Authentication · Strawberry Simulator</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <div class="card">
    <h1>3D Secure Authentication</h1>
    <p class="muted">This is a Strawberry simulator. In production, your real issuer would show this page.</p>
    <div class="session">session: ${escapeHtml(sessionId)}</div>
    <p style="margin-top:1.5rem;font-size:0.875rem;color:#555">Your one-time code:</p>
    <div class="otp">${otp}</div>
    <form method="post" action="/3ds/complete/${encodeURIComponent(sessionId)}" class="actions">
      <button class="approve" name="outcome" value="approve">Approve</button>
      <button class="attempted" name="outcome" value="attempted">Attempted</button>
      <button class="decline" name="outcome" value="decline">Decline</button>
    </form>
    <p class="note">The simulator does no real auth — clicking any button drives the callback to the api.</p>
  </div>
</body></html>`;
}

function resultPage(sessionId: string, outcome: string): string {
  const message =
    outcome === 'approve'
      ? 'Authentication approved.'
      : outcome === 'attempted'
        ? 'Authentication attempted (liability shift applies).'
        : 'Authentication declined.';
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>3DS Complete</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <div class="card">
    <h1>3DS Authentication ${escapeHtml(outcome)}</h1>
    <p class="muted">${escapeHtml(message)}</p>
    <div class="session">session: ${escapeHtml(sessionId)}</div>
    <p class="note">You may close this window. The merchant's payment flow will update via webhook + status poll.</p>
  </div>
</body></html>`;
}

export function registerThreeDsRoutes(app: FastifyInstance, deps: ThreeDsRoutesDeps = {}): void {
  const apiCallbackUrl =
    deps.apiCallbackUrl ?? `${process.env.API_BASE_URL ?? 'http://api:8080'}/v1/_internal/three_ds/callback`;
  const fetchImpl = deps.fetchImpl ?? fetch;

  app.get('/3ds/challenge/:sessionId', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    reply.type('text/html');
    return challengePage(sessionId);
  });

  app.post('/3ds/complete/:sessionId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { sessionId } = req.params as { sessionId: string };
    const body = (req.body as { outcome?: string }) ?? {};
    const outcome =
      body.outcome === 'approve' || body.outcome === 'decline' || body.outcome === 'attempted'
        ? body.outcome
        : 'decline';

    // Fire-and-forget callback. We swallow failures: the customer-facing page
    // must render regardless; ops monitors the callback success rate separately.
    void fetchImpl(apiCallbackUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, outcome }),
    }).catch((err: unknown) => {
      app.log.warn({ err, sessionId }, '3ds callback failed');
    });

    reply.type('text/html');
    return resultPage(sessionId, outcome);
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
