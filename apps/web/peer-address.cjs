'use strict';
/**
 * IRTC R1-05: the real client address for the web `/api` proxy.
 *
 * Next.js only fills `X-Forwarded-For` with the socket address when the client did not send one
 * (`??=`), and route handlers cannot see the socket. So with no trusted ingress in front
 * (`KORA_TRUSTED_PROXY_HOPS=0`) the proxy could either trust a client-chosen header (spoofable) or
 * report everyone as 127.0.0.1 (one shared rate-limit bucket for the whole platform: a DoS).
 *
 * Preloaded with `node --require ./peer-address.cjs` (see package.json, the Dockerfile and the
 * Playwright config), this stamps every incoming request with the TCP peer address in
 * `x-kora-peer-addr`, overwriting anything the client sent, before Next.js sees the request. The
 * proxy trusts that header only when this module is loaded in the same process (global flag).
 */
const http = require('node:http');

const HEADER = 'x-kora-peer-addr';
const FLAG = Symbol.for('kora.peerAddressStamp');

if (!globalThis[FLAG]) {
  globalThis[FLAG] = true;
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function stampPeerAddress(event, req, ...rest) {
    if (event === 'request' && req && req.headers) {
      req.headers[HEADER] = (req.socket && req.socket.remoteAddress) || '';
    }
    return emit.call(this, event, req, ...rest);
  };
}

module.exports = { HEADER, FLAG };
