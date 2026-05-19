/**
 * Phase 30 — Cardholder portal /api-keys views.
 */

import { cardholderLayout } from './cards-views.js';
import { esc } from './dashboard-views.js';

export interface ApiKeyRow {
  readonly id: string;
  readonly prefix: string;
  readonly env: string;
  readonly created: Date;
  readonly lastUsed: Date | null;
  readonly revoked: boolean;
}

function formatDate(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function cardholderApiKeysListPage(args: { user: string; keys: ReadonlyArray<ApiKeyRow> }): string {
  const { user, keys } = args;
  const rows =
    keys.length === 0
      ? `<tr><td colspan="5" class="muted">No keys yet. <a href="/cardholder/api-keys/new">Create one</a>.</td></tr>`
      : keys
          .map(
            (k) => `
        <tr>
          <td>${esc(k.id)}</td>
          <td><code>${esc(k.prefix)}…</code></td>
          <td>${esc(k.env)}</td>
          <td>${esc(formatDate(k.created))}</td>
          <td>${k.lastUsed ? esc(formatDate(k.lastUsed)) : '—'}</td>
          <td>${
            k.revoked
              ? '<span class="pill canceled">revoked</span>'
              : `<form method="post" action="/cardholder/api-keys/${esc(k.id)}/revoke" style="display:inline">
                   <button type="submit">Revoke</button>
                 </form>`
          }</td>
        </tr>`,
          )
          .join('');
  const body = `<h1>API keys</h1>
     <p class="subtitle">Keys to authenticate REST calls to <code>/v1/cardholder/*</code>. <a href="/cardholder/api-keys/new">+ New key</a></p>
     <div class="card">
       <table>
         <thead><tr><th>id</th><th>prefix</th><th>env</th><th>created</th><th>last used</th><th></th></tr></thead>
         <tbody>${rows}</tbody>
       </table>
     </div>`;
  return cardholderLayout('API keys', user, body);
}

export function cardholderApiKeyFormPage(args: { user: string; error?: string }): string {
  const { user, error } = args;
  const body = `<h1>New API key</h1>
     <p class="subtitle"><a href="/cardholder/api-keys">← Back</a></p>
     ${error ? `<div class="error">${esc(error)}</div>` : ''}
     <div class="card">
       <form method="post" action="/cardholder/api-keys">
         <label>Environment
           <select name="env">
             <option value="test">test</option>
             <option value="live">live</option>
           </select>
         </label>
         <button type="submit">Create</button>
       </form>
     </div>`;
  return cardholderLayout('New API key', user, body);
}

export function cardholderApiKeyCreatedPage(args: { user: string; prefix: string; raw: string }): string {
  const { user, prefix, raw } = args;
  const body = `<h1>API key created</h1>
     <p class="subtitle">Copy the key now — it will not be shown again.</p>
     <div class="card">
       <p><strong>prefix:</strong> <code>${esc(prefix)}</code></p>
       <p><strong>key:</strong></p>
       <pre style="user-select:all">${esc(raw)}</pre>
       <p><a href="/cardholder/api-keys">Got it — back to list</a></p>
     </div>`;
  return cardholderLayout('API key created', user, body);
}
