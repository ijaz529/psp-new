/**
 * Server-rendered HTML. Pure-function "templates" — no JSX, no template engine.
 * Phase 8 replaces this with a proper Next.js app; this is Phase-3 minimum.
 */

const BASE_CSS = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         background: #fafafa; color: #1a1a1a; max-width: 640px; margin: 4rem auto; padding: 0 2rem; }
  h1 { font-weight: 600; font-size: 1.5rem; margin-bottom: 0.25rem; }
  p.subtitle { color: #666; margin-top: 0; margin-bottom: 2rem; }
  form { display: flex; flex-direction: column; gap: 1rem; }
  label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.875rem; color: #444; }
  input, select { padding: 0.5rem 0.75rem; border: 1px solid #d0d0d0; border-radius: 6px; font-size: 1rem; }
  button { padding: 0.75rem 1rem; background: #1a1a1a; color: white; border: 0; border-radius: 6px;
           font-size: 1rem; cursor: pointer; }
  button:hover { background: #333; }
  .key-box { background: #f0f0f0; padding: 1rem; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, monospace;
             word-break: break-all; margin-bottom: 1rem; }
  .key-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #666; margin-bottom: 0.25rem; }
  .warning { background: #fff8dc; border-left: 4px solid #d4a017; padding: 1rem; margin-bottom: 2rem; }
  .footer { color: #888; font-size: 0.875rem; margin-top: 3rem; }
  a { color: #1a1a1a; }
`;

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(title)} · Wirecore Portal</title>
  <style>${BASE_CSS}</style>
</head>
<body>${body}</body>
</html>`;
}

export function signUpPage(error?: string): string {
  return layout(
    'Create a Merchant',
    `<h1>Create a Merchant</h1>
    <p class="subtitle">Phase 3 onboarding form. Spins up a merchant + an API key pair.</p>
    ${error ? `<div class="warning">${htmlEscape(error)}</div>` : ''}
    <form method="post" action="/sign-up">
      <label>
        Merchant name
        <input name="name" required minlength="2" maxlength="120" placeholder="Acme Inc.">
      </label>
      <label>
        Environment
        <select name="env">
          <option value="test" selected>test</option>
          <option value="live">live</option>
        </select>
      </label>
      <button type="submit">Create merchant</button>
    </form>
    <p class="footer">Or via CLI: <code>pnpm merchant:create --name "Acme Inc."</code></p>`,
  );
}

export interface CreatedView {
  readonly merchantId: string;
  readonly name: string;
  readonly env: 'test' | 'live';
  readonly publishableKey: string;
  readonly secretKey: string;
}

export function createdPage(v: CreatedView): string {
  return layout(
    'Merchant created',
    `<h1>Merchant created</h1>
    <p class="subtitle">${htmlEscape(v.name)} · <code>${htmlEscape(v.merchantId)}</code> · ${htmlEscape(v.env)}</p>
    <div class="warning">
      <strong>Save your secret key now.</strong> It will not be shown again.
      You can rotate it from <code>pnpm --filter @psp-new/api</code> once available; for now, run
      <code>pnpm merchant:create</code> to create a new merchant if you lose it.
    </div>
    <div class="key-label">Publishable key</div>
    <div class="key-box">${htmlEscape(v.publishableKey)}</div>
    <div class="key-label">Secret key</div>
    <div class="key-box">${htmlEscape(v.secretKey)}</div>
    <p><a href="/">← create another</a></p>`,
  );
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
