/**
 * The hosted-fields.js bundle delivered to merchant pages. Plain JS, no
 * compilation step — we serve it as text.
 *
 * Public API (merchant code calls these):
 *   const strawberry = Strawberry.fields({ container: '#card', publishableKey: 'pk_...' });
 *   const token = await strawberry.tokenize();   // -> { id: 'tok_...', bin, last4, scheme }
 *
 * Internally:
 *   1. Inject an iframe into the merchant's container pointed at our /iframe URL.
 *   2. tokenize() postMessages 'strawberry:submit' to the iframe.
 *   3. The iframe POSTs to api /v1/tokens with the pk and the card data.
 *   4. The iframe postMessages 'strawberry:token' back; we resolve the promise.
 *
 * Origin verification at every postMessage step.
 */
export function hostedFieldsJs(opts: { checkoutOrigin: string }): string {
  return `(function() {
  'use strict';
  var CHECKOUT_ORIGIN = ${JSON.stringify(opts.checkoutOrigin)};

  function fields(opts) {
    if (!opts || !opts.container || !opts.publishableKey) {
      throw new Error('Strawberry.fields: container + publishableKey are required');
    }
    var container = typeof opts.container === 'string'
      ? document.querySelector(opts.container)
      : opts.container;
    if (!container) throw new Error('Strawberry.fields: container not found');

    var pk = opts.publishableKey;
    var parentOrigin = window.location.origin;
    var iframeUrl = CHECKOUT_ORIGIN + '/iframe?pk=' + encodeURIComponent(pk) +
                    '&parentOrigin=' + encodeURIComponent(parentOrigin);

    var iframe = document.createElement('iframe');
    iframe.src = iframeUrl;
    iframe.style.cssText = 'width:100%;border:0;height:48px;display:block';
    iframe.setAttribute('title', 'Strawberry card input');
    iframe.setAttribute('allow', 'payment');
    container.innerHTML = '';
    container.appendChild(iframe);

    var pending = null;
    window.addEventListener('message', function(e) {
      if (e.origin !== CHECKOUT_ORIGIN) return;
      if (!e.data || typeof e.data !== 'object') return;
      if (e.data.type === 'strawberry:token' && pending) {
        pending.resolve(e.data.token);
        pending = null;
      } else if (e.data.type === 'strawberry:error' && pending) {
        pending.reject(new Error(e.data.message || 'tokenization failed'));
        pending = null;
      } else if (e.data.type === 'strawberry:ready') {
        // iframe is ready; consumers can listen via onReady but Phase 4 omits this hook
      }
    });

    return {
      tokenize: function() {
        return new Promise(function(resolve, reject) {
          if (pending) { reject(new Error('tokenize already in flight')); return; }
          pending = { resolve: resolve, reject: reject };
          iframe.contentWindow.postMessage({ type: 'strawberry:submit' }, CHECKOUT_ORIGIN);
        });
      },
      destroy: function() {
        container.innerHTML = '';
      }
    };
  }

  window.Strawberry = { fields: fields };
})();
`;
}
