/**
 * Phase 12 — cards list + detail pages. Server-rendered HTML mirroring the
 * Phase 8 portal style.
 */

import { BASE_CSS, esc, formatAmount, layout } from './dashboard-views.js';

/** Phase 22 — cardholder portal views. When `scope='cardholder'`, the page
 * renders a slim sign-out-only nav instead of the full admin nav.
 */
export type ViewScope = 'admin' | 'cardholder';

export function cardholderLayout(title: string, email: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} · Strawberry Card</title>
  <style>${BASE_CSS}</style>
</head>
<body>
<div class="nav"><span class="nav-brand">Strawberry · My Cards</span>
  <a href="/cardholder/cards">Cards</a>
  <a href="/cardholder/webhooks">Webhooks</a>
  <a href="/cardholder/api-keys">API keys</a>
  <a href="/cardholder/signout" style="margin-left:auto">${esc(email)} (sign out)</a></div>
<div class="container">${body}</div>
</body></html>`;
}

export function cardholderSignInPage(error?: string): string {
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in · Strawberry Card</title>
  <style>${BASE_CSS}</style>
</head>
<body>
<div class="container">
  <h1>Sign in</h1>
  <p class="subtitle">Cardholder sign-in. Admin creates the account; admin sets the initial password via <code>pnpm cardholder:set-password</code>.</p>
  ${error ? `<div class="error">${esc(error)}</div>` : ''}
  <div class="card">
    <form method="post" action="/cardholder/signin">
      <label>Email<input name="email" type="email" required autofocus></label>
      <label>Password<input name="password" type="password" required minlength="8"></label>
      <button type="submit">Sign in</button>
    </form>
  </div>
</div></body></html>`;
}

export interface CardListRow {
  readonly id: string;
  readonly bin: string;
  readonly last4: string;
  readonly status: string;
  readonly currency: string;
  readonly cardholderEmail: string;
  readonly cardholderName: string;
  readonly productName: string;
  readonly fundedBalance: bigint;
}

export function cardsListPage(args: {
  user: string;
  cards: ReadonlyArray<CardListRow>;
  scope?: ViewScope;
}): string {
  const { user, cards, scope = 'admin' } = args;
  const linkBase = scope === 'cardholder' ? '/cardholder/cards' : '/cards';
  const colCount = scope === 'admin' ? 6 : 5;
  const rows =
    cards.length === 0
      ? `<tr><td colspan="${colCount}" class="muted">No cards yet${scope === 'admin' ? '. Issue one via <code>pnpm card:issue</code>.' : '.'}</td></tr>`
      : cards
          .map(
            (c) => `
        <tr>
          <td><a href="${linkBase}/${esc(c.id)}">${esc(c.id)}</a></td>
          ${scope === 'admin' ? `<td>${esc(c.cardholderEmail)}<div class="muted" style="font-size:0.75rem">${esc(c.cardholderName)}</div></td>` : ''}
          <td>${esc(c.bin)}…${esc(c.last4)}</td>
          <td>${esc(c.productName)}</td>
          <td><span class="pill ${esc(statusClass(c.status))}">${esc(c.status)}</span></td>
          <td>${formatAmount(c.fundedBalance, c.currency)}</td>
        </tr>`,
          )
          .join('');

  const heading = scope === 'cardholder' ? 'My cards' : 'Cards';
  const subtitle =
    scope === 'cardholder'
      ? 'Your issued cards. Click a card for balance, recent loads, and recent auth holds.'
      : 'All issued cards across all cardholders. Admin view.';
  const body = `<h1>${esc(heading)}</h1>
     <p class="subtitle">${esc(subtitle)}</p>
     <div class="card">
       <table>
         <thead><tr><th>id</th>${scope === 'admin' ? '<th>cardholder</th>' : ''}<th>card</th><th>product</th><th>status</th><th>available</th></tr></thead>
         <tbody>${rows}</tbody>
       </table>
     </div>`;
  return scope === 'cardholder' ? cardholderLayout(heading, user, body) : layout('Cards', user, body);
}

export interface CardDetail {
  readonly id: string;
  readonly bin: string;
  readonly last4: string;
  readonly expMonth: string;
  readonly expYear: string;
  readonly status: string;
  readonly currency: string;
  readonly productName: string;
  readonly productId: string;
  readonly cardholderId: string;
  readonly cardholderEmail: string;
  readonly cardholderName: string;
  readonly fundedAccountId: string;
  readonly holdsAccountId: string;
  readonly fundedBalance: bigint;
  readonly holdsBalance: bigint;
  /** Per-card controls overlay (camelCase, matches @psp-new/issuing CardControls). */
  readonly controls: { dailyLimit?: number; mccBlocklist?: ReadonlyArray<string> };
}

export interface CardLoadRow {
  readonly id: string;
  readonly amount: bigint;
  readonly currency: string;
  readonly status: string;
  readonly responseCode: string;
  readonly rrn: string | null;
  readonly stan: string | null;
  readonly failureCode: string | null;
  readonly created: Date;
}

export interface CardAuthHoldRow {
  readonly id: string;
  readonly amount: bigint;
  readonly currency: string;
  readonly stan: string;
  readonly rrn: string;
  readonly mcc: string | null;
  readonly merchantName: string | null;
  readonly approvalCode: string | null;
  readonly resolvedReason: string | null;
  readonly resolvedAt: Date | null;
  readonly created: Date;
}

export function cardDetailPage(args: {
  user: string;
  card: CardDetail;
  loads: ReadonlyArray<CardLoadRow>;
  authHolds: ReadonlyArray<CardAuthHoldRow>;
  scope?: ViewScope;
}): string {
  const { user, card, loads, authHolds, scope = 'admin' } = args;
  const listHref = scope === 'cardholder' ? '/cardholder/cards' : '/cards';

  const loadRows =
    loads.length === 0
      ? `<tr><td colspan="7" class="muted">No loads yet.</td></tr>`
      : loads
          .map(
            (l) => `
        <tr>
          <td>${esc(l.id)}</td>
          <td>${formatAmount(l.amount, l.currency)}</td>
          <td><span class="pill ${esc(statusClass(l.status))}">${esc(l.status)}</span></td>
          <td>${esc(l.responseCode)}${l.failureCode ? `<div class="muted" style="font-size:0.75rem">${esc(l.failureCode)}</div>` : ''}</td>
          <td>${esc(l.rrn ?? '—')}</td>
          <td>${esc(l.stan ?? '—')}</td>
          <td>${esc(formatDate(l.created))}</td>
        </tr>`,
          )
          .join('');

  const holdRows =
    authHolds.length === 0
      ? `<tr><td colspan="7" class="muted">No auth holds yet.</td></tr>`
      : authHolds
          .map(
            (h) => `
        <tr>
          <td>${esc(h.id)}</td>
          <td>${formatAmount(h.amount, h.currency)}</td>
          <td>${esc(h.merchantName ?? '—')}${h.mcc ? `<div class="muted" style="font-size:0.75rem">MCC ${esc(h.mcc)}</div>` : ''}</td>
          <td>${esc(h.rrn)}</td>
          <td>${esc(h.stan)}</td>
          <td><span class="pill ${esc(holdStatusClass(h.resolvedReason))}">${esc(h.resolvedReason ?? 'open')}</span></td>
          <td>${esc(formatDate(h.created))}</td>
        </tr>`,
          )
          .join('');

  const body = `<h1>${esc(card.id)}</h1>
     <p class="subtitle"><a href="${listHref}">← ${scope === 'cardholder' ? 'My cards' : 'All cards'}</a></p>

     <div class="card">
       <h2>Card</h2>
       <table>
         <tr><th>cardholder</th><td>${esc(card.cardholderEmail)} <span class="muted">(${esc(card.cardholderName)})</span></td></tr>
         <tr><th>cardholder_id</th><td>${esc(card.cardholderId)}</td></tr>
         <tr><th>card</th><td>${esc(card.bin)}…${esc(card.last4)} · exp ${esc(card.expMonth)}/${esc(card.expYear.slice(2))}</td></tr>
         <tr><th>product</th><td>${esc(card.productName)} <span class="muted">(${esc(card.productId)})</span></td></tr>
         <tr><th>status</th>
           <td>
             <span class="pill ${esc(statusClass(card.status))}">${esc(card.status)}</span>
             ${scope === 'admin' ? freezeToggleForm(card.id, card.status) : ''}
           </td>
         </tr>
       </table>
     </div>

     ${
       scope === 'admin'
         ? `<div class="card">
       <h2>Controls</h2>
       <p class="subtitle" style="margin-bottom:1rem">
         Per-card overlay. Blank fields fall through to the product defaults.
       </p>
       ${controlsForm(card.id, card.controls, card.status === 'cancelled')}
     </div>`
         : ''
     }

     <div class="card">
       <h2>Balance (${esc(card.currency)})</h2>
       <table>
         <tr><th>available (funded)</th><td>${formatAmount(card.fundedBalance, card.currency)}</td></tr>
         <tr><th>holds (pending)</th><td>${formatAmount(card.holdsBalance, card.currency)}</td></tr>
         <tr><th>funded_account_id</th><td>${esc(card.fundedAccountId)}</td></tr>
         <tr><th>holds_account_id</th><td>${esc(card.holdsAccountId)}</td></tr>
       </table>
     </div>

     <div class="card">
       <h2>Recent loads (last ${loads.length})</h2>
       <table>
         <thead><tr><th>id</th><th>amount</th><th>status</th><th>RC</th><th>RRN</th><th>STAN</th><th>when</th></tr></thead>
         <tbody>${loadRows}</tbody>
       </table>
     </div>

     <div class="card">
       <h2>Recent auth holds (last ${authHolds.length})</h2>
       <table>
         <thead><tr><th>id</th><th>amount</th><th>merchant</th><th>RRN</th><th>STAN</th><th>status</th><th>when</th></tr></thead>
         <tbody>${holdRows}</tbody>
       </table>
     </div>`;
  return scope === 'cardholder'
    ? cardholderLayout(`Card ${card.id}`, user, body)
    : layout(`Card ${card.id}`, user, body);
}

function statusClass(status: string): string {
  switch (status) {
    case 'active':
    case 'succeeded':
    case 'captured':
      return 'succeeded';
    case 'failed':
    case 'cancelled':
    case 'reversed':
      return 'failed';
    case 'frozen':
    case 'expired':
      return 'canceled';
    default:
      return '';
  }
}

function holdStatusClass(resolvedReason: string | null): string {
  if (resolvedReason === null) return 'processing'; // open hold
  return statusClass(resolvedReason);
}

function formatDate(d: Date): string {
  // YYYY-MM-DD HH:MM UTC
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function freezeToggleForm(cardId: string, status: string): string {
  // Terminal status — no action.
  if (status === 'cancelled') return '';
  const action = status === 'active' ? 'freeze' : 'unfreeze';
  const label = status === 'active' ? 'Freeze' : 'Unfreeze';
  return `<form method="post" action="/cards/${esc(cardId)}/${action}" style="display:inline;margin-left:0.75rem">
    <button type="submit" style="padding:0.25rem 0.625rem;font-size:0.75rem">${label}</button>
  </form>`;
}

function controlsForm(
  cardId: string,
  controls: { dailyLimit?: number; mccBlocklist?: ReadonlyArray<string> },
  disabled: boolean,
): string {
  const dailyValue = controls.dailyLimit !== undefined ? String(controls.dailyLimit) : '';
  const mccValue = (controls.mccBlocklist ?? []).join(', ');
  if (disabled) {
    return `<p class="muted" style="font-style:italic">Card is cancelled — controls cannot be edited.</p>`;
  }
  return `<form method="post" action="/cards/${esc(cardId)}/controls">
    <label>Daily limit (minor units, blank = inherit)
      <input name="daily_limit" type="number" min="0" max="1000000000" value="${esc(dailyValue)}">
    </label>
    <label>MCC blocklist (comma-separated 4-digit codes, blank = inherit)
      <input name="mcc_blocklist" type="text" pattern="[\\d, ]*" value="${esc(mccValue)}">
    </label>
    <button type="submit">Save controls</button>
  </form>`;
}
