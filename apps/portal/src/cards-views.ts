/**
 * Phase 12 — cards list + detail pages. Server-rendered HTML mirroring the
 * Phase 8 portal style.
 */

import { esc, formatAmount, layout } from './dashboard-views.js';

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

export function cardsListPage(args: { user: string; cards: ReadonlyArray<CardListRow> }): string {
  const { user, cards } = args;
  const rows =
    cards.length === 0
      ? `<tr><td colspan="6" class="muted">No cards yet. Issue one via <code>pnpm card:issue</code>.</td></tr>`
      : cards
          .map(
            (c) => `
        <tr>
          <td><a href="/cards/${esc(c.id)}">${esc(c.id)}</a></td>
          <td>${esc(c.cardholderEmail)}<div class="muted" style="font-size:0.75rem">${esc(c.cardholderName)}</div></td>
          <td>${esc(c.bin)}…${esc(c.last4)}</td>
          <td>${esc(c.productName)}</td>
          <td><span class="pill ${esc(statusClass(c.status))}">${esc(c.status)}</span></td>
          <td>${formatAmount(c.fundedBalance, c.currency)}</td>
        </tr>`,
          )
          .join('');

  return layout(
    'Cards',
    user,
    `<h1>Cards</h1>
     <p class="subtitle">All issued cards across all cardholders. Admin view — cardholder identity scoping is a future phase.</p>
     <div class="card">
       <table>
         <thead><tr><th>id</th><th>cardholder</th><th>card</th><th>product</th><th>status</th><th>available</th></tr></thead>
         <tbody>${rows}</tbody>
       </table>
     </div>`,
  );
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
}): string {
  const { user, card, loads, authHolds } = args;

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

  return layout(
    `Card ${card.id}`,
    user,
    `<h1>${esc(card.id)}</h1>
     <p class="subtitle"><a href="/cards">← All cards</a></p>

     <div class="card">
       <h2>Card</h2>
       <table>
         <tr><th>cardholder</th><td>${esc(card.cardholderEmail)} <span class="muted">(${esc(card.cardholderName)})</span></td></tr>
         <tr><th>cardholder_id</th><td>${esc(card.cardholderId)}</td></tr>
         <tr><th>card</th><td>${esc(card.bin)}…${esc(card.last4)} · exp ${esc(card.expMonth)}/${esc(card.expYear.slice(2))}</td></tr>
         <tr><th>product</th><td>${esc(card.productName)} <span class="muted">(${esc(card.productId)})</span></td></tr>
         <tr><th>status</th><td><span class="pill ${esc(statusClass(card.status))}">${esc(card.status)}</span></td></tr>
       </table>
     </div>

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
     </div>`,
  );
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
