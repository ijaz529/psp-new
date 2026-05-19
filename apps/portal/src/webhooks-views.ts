/**
 * Phase 27 — Cardholder portal /webhooks views. Server-rendered HTML
 * mirroring the cards-views.ts conventions.
 */

import { cardholderLayout } from './cards-views.js';
import { esc } from './dashboard-views.js';

export interface WebhookEndpointRow {
  readonly id: string;
  readonly url: string;
  readonly description: string | null;
  readonly status: string;
  readonly enabledEvents: ReadonlyArray<string>;
  readonly created: Date;
}

export interface WebhookAttemptRow {
  readonly id: string;
  readonly eventId: string;
  readonly attemptNumber: number;
  readonly httpStatus: number | null;
  readonly error: string | null;
  readonly deliveredAt: Date | null;
  readonly created: Date;
}

function formatDate(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function statusPill(status: string): string {
  const cls = status === 'enabled' ? 'succeeded' : status === 'disabled' ? 'canceled' : 'failed';
  return `<span class="pill ${cls}">${esc(status)}</span>`;
}

export function cardholderWebhooksListPage(args: {
  user: string;
  endpoints: ReadonlyArray<WebhookEndpointRow>;
}): string {
  const { user, endpoints } = args;
  const rows =
    endpoints.length === 0
      ? `<tr><td colspan="5" class="muted">No webhook endpoints yet. <a href="/cardholder/webhooks/new">Create one</a>.</td></tr>`
      : endpoints
          .map(
            (e) => `
        <tr>
          <td><a href="/cardholder/webhooks/${esc(e.id)}">${esc(e.id)}</a></td>
          <td><code>${esc(e.url)}</code>${e.description ? `<div class="muted" style="font-size:0.75rem">${esc(e.description)}</div>` : ''}</td>
          <td>${statusPill(e.status)}</td>
          <td>${e.enabledEvents.map((ev) => `<code>${esc(ev)}</code>`).join(' ')}</td>
          <td>${esc(formatDate(e.created))}</td>
        </tr>`,
          )
          .join('');
  const body = `<h1>Webhooks</h1>
     <p class="subtitle">Endpoints that receive HMAC-signed events about your cards. <a href="/cardholder/webhooks/new">+ New endpoint</a></p>
     <div class="card">
       <table>
         <thead><tr><th>id</th><th>url</th><th>status</th><th>events</th><th>created</th></tr></thead>
         <tbody>${rows}</tbody>
       </table>
     </div>`;
  return cardholderLayout('Webhooks', user, body);
}

export function cardholderWebhookFormPage(args: { user: string; error?: string }): string {
  const { user, error } = args;
  const body = `<h1>New webhook endpoint</h1>
     <p class="subtitle"><a href="/cardholder/webhooks">← Back</a></p>
     ${error ? `<div class="error">${esc(error)}</div>` : ''}
     <div class="card">
       <form method="post" action="/cardholder/webhooks">
         <label>URL<input name="url" type="url" required placeholder="https://your-host.example/webhook"></label>
         <label>Events (comma-separated, or <code>*</code> for all)
           <input name="events" type="text" placeholder="card_load.*, card.*" value="*">
         </label>
         <label>Description (optional)<input name="description" type="text" maxlength="200"></label>
         <button type="submit">Create</button>
       </form>
     </div>`;
  return cardholderLayout('New webhook endpoint', user, body);
}

export function cardholderWebhookCreatedPage(args: {
  user: string;
  endpoint: WebhookEndpointRow;
  secret: string;
}): string {
  const { user, endpoint, secret } = args;
  const body = `<h1>Endpoint created</h1>
     <p class="subtitle">Copy the signing secret now — it will not be shown again.</p>
     <div class="card">
       <p><strong>id:</strong> <code>${esc(endpoint.id)}</code></p>
       <p><strong>url:</strong> <code>${esc(endpoint.url)}</code></p>
       <p><strong>signing secret:</strong></p>
       <pre style="user-select:all">${esc(secret)}</pre>
       <p><a href="/cardholder/webhooks">Got it — back to list</a></p>
     </div>`;
  return cardholderLayout('Endpoint created', user, body);
}

export function cardholderWebhookDetailPage(args: {
  user: string;
  endpoint: WebhookEndpointRow;
  attempts: ReadonlyArray<WebhookAttemptRow>;
}): string {
  const { user, endpoint, attempts } = args;
  const rows =
    attempts.length === 0
      ? `<tr><td colspan="5" class="muted">No delivery attempts yet.</td></tr>`
      : attempts
          .map(
            (a) => `
        <tr>
          <td>${esc(a.eventId)}</td>
          <td>#${a.attemptNumber}</td>
          <td>${a.httpStatus !== null ? a.httpStatus : '—'}</td>
          <td>${a.deliveredAt ? '✓ delivered' : esc(a.error ?? 'pending')}</td>
          <td>${esc(formatDate(a.created))}</td>
        </tr>`,
          )
          .join('');
  const disableForm =
    endpoint.status === 'enabled'
      ? `<form method="post" action="/cardholder/webhooks/${esc(endpoint.id)}/disable" style="display:inline">
           <button type="submit">Disable endpoint</button>
         </form>`
      : '';
  const body = `<h1>${esc(endpoint.id)}</h1>
     <p class="subtitle"><a href="/cardholder/webhooks">← All endpoints</a></p>
     <div class="card">
       <p><strong>url:</strong> <code>${esc(endpoint.url)}</code></p>
       <p><strong>status:</strong> ${statusPill(endpoint.status)} ${disableForm}</p>
       <p><strong>events:</strong> ${endpoint.enabledEvents.map((ev) => `<code>${esc(ev)}</code>`).join(' ')}</p>
       <p><strong>created:</strong> ${esc(formatDate(endpoint.created))}</p>
       ${endpoint.description ? `<p><strong>description:</strong> ${esc(endpoint.description)}</p>` : ''}
     </div>
     <h2>Recent attempts</h2>
     <div class="card">
       <table>
         <thead><tr><th>event</th><th>attempt</th><th>http</th><th>result</th><th>at</th></tr></thead>
         <tbody>${rows}</tbody>
       </table>
     </div>`;
  return cardholderLayout(`Endpoint ${endpoint.id}`, user, body);
}
