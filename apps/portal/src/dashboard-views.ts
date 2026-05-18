/**
 * Dashboard views — server-rendered HTML for Phase 8. Plain template strings
 * to keep dependencies minimal; Phase 9 swaps in Next.js with proper components.
 */

const BASE_CSS = `
  * { box-sizing: border-box }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         background: #fafafa; color: #1a1a1a; margin: 0; }
  .nav { background: #1a1a1a; color: white; padding: 0.75rem 2rem; display: flex; align-items: center; gap: 1.5rem; }
  .nav a { color: #ddd; text-decoration: none; font-size: 0.875rem; }
  .nav a:hover { color: white; }
  .nav-brand { font-weight: 600; font-size: 1rem; color: white; flex: 1; }
  .container { max-width: 1120px; margin: 2rem auto; padding: 0 2rem; }
  h1 { font-weight: 600; font-size: 1.5rem; margin-bottom: 0.25rem; }
  p.subtitle { color: #666; margin-top: 0; margin-bottom: 2rem; }
  .card { background: white; border: 1px solid #e5e5e5; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; }
  .card h2 { margin: 0 0 1rem; font-size: 1rem; font-weight: 600; color: #444; }
  table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
  th { text-align: left; padding: 0.5rem 0.75rem; background: #f0f0f0; border-bottom: 1px solid #d0d0d0;
       font-weight: 500; color: #555; }
  td { padding: 0.625rem 0.75rem; border-bottom: 1px solid #f0f0f0; font-family: ui-monospace, monospace; font-size: 0.8rem; }
  td.muted { color: #999; }
  .pill { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 999px; font-size: 0.75rem; font-weight: 500; }
  .pill.succeeded { background: #e9f5e9; color: #1a7f37; }
  .pill.failed { background: #ffe9eb; color: #cf222e; }
  .pill.processing, .pill.requires_action, .pill.requires_capture { background: #fff5d6; color: #9a6700; }
  .pill.canceled, .pill.expired { background: #f0f0f0; color: #666; }
  form { display: flex; flex-direction: column; gap: 0.75rem; max-width: 32rem; }
  label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.875rem; color: #444; }
  input, select, textarea { padding: 0.5rem 0.75rem; border: 1px solid #d0d0d0; border-radius: 6px; font-size: 0.875rem; }
  button { padding: 0.625rem 1rem; background: #1a1a1a; color: white; border: 0; border-radius: 6px;
           font-size: 0.875rem; cursor: pointer; }
  button:hover { background: #333; }
  .error { background: #ffe9eb; border-left: 4px solid #cf222e; padding: 0.75rem 1rem; margin-bottom: 1rem; color: #5a0c14; }
`;

export function layout(title: string, user: string | null, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} · Wirecore Portal</title>
  <style>${BASE_CSS}</style>
</head>
<body>
${
  user
    ? `<div class="nav"><span class="nav-brand">Wirecore Portal</span>
   <a href="/dashboard">Dashboard</a>
   <a href="/merchants">Merchants</a>
   <a href="/payouts">Payouts</a>
   <a href="/disputes">Disputes</a>
   <a href="/signout" style="margin-left:auto">${esc(user)} (sign out)</a></div>`
    : ''
}
<div class="container">${body}</div>
</body></html>`;
}

export function signInPage(error?: string): string {
  return layout(
    'Sign in',
    null,
    `<h1>Sign in</h1>
     <p class="subtitle">Portal admin sign-in. Seed users via <code>pnpm --filter @psp-new/portal user:create</code>.</p>
     ${error ? `<div class="error">${esc(error)}</div>` : ''}
     <div class="card">
       <form method="post" action="/signin">
         <label>Email<input name="email" type="email" required autofocus></label>
         <label>Password<input name="password" type="password" required minlength="8"></label>
         <button type="submit">Sign in</button>
       </form>
     </div>`,
  );
}

export function dashboardPage(args: {
  user: string;
  merchantCount: number;
  recentTransactions: ReadonlyArray<{
    id: string;
    merchant: string;
    amount: bigint;
    currency: string;
    status: string;
    created: Date;
  }>;
  recentPayouts: ReadonlyArray<{
    id: string;
    merchant: string;
    amount: bigint;
    currency: string;
    status: string;
    scheduled: Date;
  }>;
  recentDisputes: ReadonlyArray<{ id: string; merchant: string; state: string; reason: string; created: Date }>;
}): string {
  return layout(
    'Dashboard',
    args.user,
    `<h1>Dashboard</h1>
     <p class="subtitle">Overview of the Wirecore platform — ${args.merchantCount} merchant(s).</p>

     <div class="card">
       <h2>Recent transactions</h2>
       ${transactionsTable(args.recentTransactions)}
     </div>
     <div class="card">
       <h2>Recent payouts</h2>
       ${payoutsTable(args.recentPayouts)}
     </div>
     <div class="card">
       <h2>Recent disputes</h2>
       ${disputesTable(args.recentDisputes)}
     </div>`,
  );
}

export function merchantsListPage(args: {
  user: string;
  merchants: ReadonlyArray<{ id: string; name: string; env: string; kyb_status: string; created: Date }>;
}): string {
  const rows = args.merchants.length
    ? args.merchants
        .map(
          (m) => `<tr>
            <td>${esc(m.id)}</td>
            <td>${esc(m.name)}</td>
            <td>${esc(m.env)}</td>
            <td><span class="pill ${m.kyb_status === 'approved' ? 'succeeded' : m.kyb_status === 'rejected' ? 'failed' : 'processing'}">${esc(m.kyb_status)}</span></td>
            <td>${esc(m.created.toISOString().slice(0, 10))}</td>
            <td><a href="/merchants/${esc(m.id)}">view</a></td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="6" class="muted">no merchants — run <code>pnpm merchant:create --name "..."</code></td></tr>`;
  return layout(
    'Merchants',
    args.user,
    `<h1>Merchants</h1>
     <p class="subtitle">All merchants registered on the platform.</p>
     <div class="card"><table>
       <thead><tr><th>id</th><th>name</th><th>env</th><th>kyb</th><th>created</th><th></th></tr></thead>
       <tbody>${rows}</tbody>
     </table></div>`,
  );
}

export function merchantDetailPage(args: {
  user: string;
  merchant: {
    id: string;
    name: string;
    env: string;
    kyb_status: string;
    allowed_origins: string[];
    reserve_basis_points: number;
  };
  apiKeys: ReadonlyArray<{ kind: string; prefix: string; last_used_at: Date | null; revoked_at: Date | null }>;
  webhooks: ReadonlyArray<{ id: string; url: string; status: string }>;
  recentTransactions: ReadonlyArray<{ id: string; amount: bigint; currency: string; status: string; created: Date }>;
}): string {
  return layout(
    args.merchant.name,
    args.user,
    `<h1>${esc(args.merchant.name)}</h1>
     <p class="subtitle"><code>${esc(args.merchant.id)}</code> · ${esc(args.merchant.env)} · KYB: ${esc(args.merchant.kyb_status)}</p>

     <div class="card">
       <h2>API keys</h2>
       ${
         args.apiKeys.length
           ? `<table>
         <thead><tr><th>kind</th><th>prefix</th><th>last used</th><th>status</th></tr></thead>
         <tbody>${args.apiKeys
           .map(
             (k) => `<tr>
           <td>${esc(k.kind)}</td>
           <td>${esc(k.prefix)}…</td>
           <td>${k.last_used_at ? esc(k.last_used_at.toISOString()) : '<span class="muted">never</span>'}</td>
           <td>${k.revoked_at ? '<span class="pill failed">revoked</span>' : '<span class="pill succeeded">active</span>'}</td>
         </tr>`,
           )
           .join('')}</tbody>
       </table>`
           : '<p class="muted">no keys</p>'
       }
     </div>

     <div class="card">
       <h2>Webhook endpoints</h2>
       ${
         args.webhooks.length
           ? `<table>
         <thead><tr><th>id</th><th>url</th><th>status</th></tr></thead>
         <tbody>${args.webhooks
           .map(
             (w) => `<tr>
           <td>${esc(w.id)}</td><td>${esc(w.url)}</td>
           <td><span class="pill ${w.status === 'enabled' ? 'succeeded' : 'canceled'}">${esc(w.status)}</span></td>
         </tr>`,
           )
           .join('')}</tbody>
       </table>`
           : '<p class="muted">no webhook endpoints</p>'
       }
     </div>

     <div class="card">
       <h2>Recent transactions</h2>
       ${transactionsTable(args.recentTransactions.map((t) => ({ ...t, merchant: args.merchant.id })))}
     </div>

     <div class="card">
       <h2>KYB</h2>
       <form method="post" action="/merchants/${esc(args.merchant.id)}/kyb">
         <label>Legal entity name<input name="legal_name" required></label>
         <label>Registered country (ISO-2)<input name="country" required maxlength="2"></label>
         <label>Tax ID<input name="tax_id" required></label>
         <label>MCC<input name="mcc" required pattern="\\d{4}"></label>
         <label>Notes<textarea name="notes" rows="3"></textarea></label>
         <button type="submit">Submit KYB</button>
       </form>
     </div>`,
  );
}

function transactionsTable(
  txs: ReadonlyArray<{
    id: string;
    merchant?: string;
    amount: bigint;
    currency: string;
    status: string;
    created: Date;
  }>,
): string {
  if (txs.length === 0) return '<p class="muted">no transactions yet</p>';
  return `<table>
    <thead><tr><th>id</th>${txs[0]?.merchant !== undefined ? '<th>merchant</th>' : ''}<th>amount</th><th>status</th><th>created</th></tr></thead>
    <tbody>${txs
      .map(
        (t) => `<tr>
          <td>${esc(t.id)}</td>
          ${t.merchant !== undefined ? `<td>${esc(t.merchant)}</td>` : ''}
          <td>${formatAmount(t.amount, t.currency)}</td>
          <td><span class="pill ${esc(t.status)}">${esc(t.status)}</span></td>
          <td>${esc(t.created.toISOString().slice(0, 19).replace('T', ' '))}</td>
        </tr>`,
      )
      .join('')}</tbody>
  </table>`;
}

function payoutsTable(
  ps: ReadonlyArray<{
    id: string;
    merchant: string;
    amount: bigint;
    currency: string;
    status: string;
    scheduled: Date;
  }>,
): string {
  if (ps.length === 0) return '<p class="muted">no payouts yet</p>';
  return `<table>
    <thead><tr><th>id</th><th>merchant</th><th>amount</th><th>status</th><th>scheduled</th></tr></thead>
    <tbody>${ps
      .map(
        (p) => `<tr>
          <td>${esc(p.id)}</td><td>${esc(p.merchant)}</td>
          <td>${formatAmount(p.amount, p.currency)}</td>
          <td><span class="pill ${esc(p.status)}">${esc(p.status)}</span></td>
          <td>${esc(p.scheduled.toISOString().slice(0, 10))}</td>
        </tr>`,
      )
      .join('')}</tbody>
  </table>`;
}

function disputesTable(
  ds: ReadonlyArray<{ id: string; merchant: string; state: string; reason: string; created: Date }>,
): string {
  if (ds.length === 0) return '<p class="muted">no disputes yet</p>';
  return `<table>
    <thead><tr><th>id</th><th>merchant</th><th>reason</th><th>state</th><th>created</th></tr></thead>
    <tbody>${ds
      .map(
        (d) => `<tr>
          <td>${esc(d.id)}</td><td>${esc(d.merchant)}</td><td>${esc(d.reason)}</td>
          <td><span class="pill ${d.state === 'won' ? 'succeeded' : d.state === 'lost' ? 'failed' : 'processing'}">${esc(d.state)}</span></td>
          <td>${esc(d.created.toISOString().slice(0, 10))}</td>
        </tr>`,
      )
      .join('')}</tbody>
  </table>`;
}

function formatAmount(amount: bigint, currency: string): string {
  return `${(Number(amount) / 100).toFixed(2)} ${esc(currency)}`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
