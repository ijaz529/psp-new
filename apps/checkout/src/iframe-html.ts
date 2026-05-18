/**
 * HTML rendered inside the iframe. The card input lives here — the merchant
 * page never sees the PAN.
 *
 *   - On 'strawberry:submit' postMessage, validate + POST to api /v1/tokens.
 *   - On success, postMessage 'strawberry:token' back to parent.
 *
 * CSP: `frame-ancestors` is set by the route handler from merchant.allowed_origins.
 */
export function iframeHtml(opts: {
  apiBaseUrl: string;
  publishableKey: string;
  parentOrigin: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Strawberry Card Input</title>
<style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: white; color: #1a1a1a; }
  form { display: flex; gap: 0.5rem; align-items: stretch; }
  .number-wrap { flex: 1 1 60%; }
  .exp-wrap   { flex: 1 1 22%; }
  .cvc-wrap   { flex: 1 1 18%; }
  input { width: 100%; box-sizing: border-box; padding: 0.625rem 0.75rem; border: 1px solid #d0d0d0;
          border-radius: 6px; font-size: 1rem; font-family: ui-monospace, SFMono-Regular, monospace; }
  input:focus { outline: 2px solid #0066ff; border-color: #0066ff; }
  input.invalid { border-color: #cf222e; }
  #status { margin-top: 0.5rem; font-size: 0.75rem; color: #777; height: 1rem; }
  #status.error { color: #cf222e; }
</style>
</head>
<body>
  <form id="f" autocomplete="off">
    <div class="number-wrap"><input id="number" inputmode="numeric" maxlength="23" placeholder="Card number" required></div>
    <div class="exp-wrap"><input id="exp" inputmode="numeric" maxlength="7" placeholder="MM / YYYY" required></div>
    <div class="cvc-wrap"><input id="cvc" inputmode="numeric" maxlength="4" placeholder="CVC"></div>
  </form>
  <div id="status"></div>
<script>
(function() {
  'use strict';
  var API = ${JSON.stringify(opts.apiBaseUrl)};
  var PK = ${JSON.stringify(opts.publishableKey)};
  var PARENT = ${JSON.stringify(opts.parentOrigin)};
  var statusEl = document.getElementById('status');
  var numEl = document.getElementById('number');
  var expEl = document.getElementById('exp');
  var cvcEl = document.getElementById('cvc');

  // Strip non-digits + insert spaces every 4 digits for readability.
  numEl.addEventListener('input', function() {
    var digits = numEl.value.replace(/\\D/g, '').slice(0, 19);
    numEl.value = digits.match(/.{1,4}/g)?.join(' ') ?? '';
  });
  expEl.addEventListener('input', function() {
    var digits = expEl.value.replace(/\\D/g, '').slice(0, 6);
    if (digits.length >= 3) digits = digits.slice(0, 2) + ' / ' + digits.slice(2);
    expEl.value = digits;
  });

  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.className = isError ? 'error' : '';
  }

  async function submit() {
    var number = numEl.value.replace(/\\s+/g, '');
    var expParts = expEl.value.split('/').map(function(s) { return s.trim(); });
    if (!number || !expParts[0] || !expParts[1]) {
      setStatus('Please complete card details.', true);
      window.parent.postMessage({ type: 'strawberry:error', message: 'incomplete' }, PARENT);
      return;
    }
    setStatus('Tokenizing…', false);
    try {
      var res = await fetch(API + '/v1/tokens', {
        method: 'POST',
        headers: { 'authorization': 'Bearer ' + PK, 'content-type': 'application/json' },
        body: JSON.stringify({ card: {
          number: number,
          exp_month: expParts[0].padStart(2, '0'),
          exp_year: expParts[1].length === 2 ? '20' + expParts[1] : expParts[1],
          cvc: cvcEl.value || undefined,
        } }),
      });
      var json = await res.json();
      if (!res.ok) {
        var msg = (json && json.error && json.error.message) || ('http ' + res.status);
        setStatus(msg, true);
        window.parent.postMessage({ type: 'strawberry:error', message: msg }, PARENT);
        return;
      }
      setStatus('', false);
      window.parent.postMessage({ type: 'strawberry:token', token: json }, PARENT);
    } catch (err) {
      var msg = (err && err.message) || 'network error';
      setStatus(msg, true);
      window.parent.postMessage({ type: 'strawberry:error', message: msg }, PARENT);
    }
  }

  window.addEventListener('message', function(e) {
    if (e.origin !== PARENT) return;
    if (e.data && e.data.type === 'strawberry:submit') submit();
  });

  window.parent.postMessage({ type: 'strawberry:ready' }, PARENT);
})();
</script>
</body>
</html>`;
}
