// Patch fetch BEFORE genlayer-js loads. ES modules capture `fetch` at import
// time, so a module-level patch is invisible to them — a classic <script> tag
// must run first. viem sends JSON-RPC `id` as a string; GenLayer's Go RPC
// requires an integer, otherwise every tx approval fails with a parse error.
(function () {
  const _fetch = window.fetch;
  let requestId = 0;
  window.fetch = function (input, init) {
    if (init && init.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        if (body && body.jsonrpc === '2.0') {
          if (typeof body.id === 'string') {
            body.id = parseInt(body.id, 10) || 1;
          } else if (typeof body.id !== 'number') {
            body.id = ++requestId;
          }
          init = Object.assign({}, init, { body: JSON.stringify(body) });
        }
      } catch (e) { /* not JSON-RPC, leave it alone */ }
    }
    return _fetch.call(this, input, init);
  };
})();
