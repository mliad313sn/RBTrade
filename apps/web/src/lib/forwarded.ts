/**
 * Client address forwarded to the API (goal 10, B-015).
 *
 * The web `/api` proxy must never pass a client-chosen `X-Forwarded-For` value on: the API keys
 * per-IP rate limits and audit IPs on it. Only entries appended by proxies we operate are trusted:
 * with `hops` trusted proxies in front of the web server (`KORA_TRUSTED_PROXY_HOPS`, e.g. 1 behind
 * one ingress), the client address is the `hops`-th entry from the right. With 0 (the default: no
 * trusted proxy configured) the header is ignored; `clientAddress` then uses the TCP peer stamped by
 * the `peer-address.cjs` preload (IRTC R1-05), never a client-chosen value.
 */
export function forwardedClient(xff: string | null | undefined, hops: number): string {
  if (!Number.isInteger(hops) || hops <= 0) return '127.0.0.1';
  const chain = (xff ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const candidate = chain[chain.length - hops];
  return candidate && /^[0-9a-fA-F:.]{2,45}$/.test(candidate) ? candidate : '127.0.0.1';
}

export function trustedProxyHops(): number {
  const n = Number(process.env.KORA_TRUSTED_PROXY_HOPS ?? '0');
  return Number.isInteger(n) && n >= 0 && n <= 5 ? n : 0;
}

const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;
export const PEER_HEADER = 'x-kora-peer-addr';
const PEER_FLAG = Symbol.for('kora.peerAddressStamp');

/** True when `peer-address.cjs` is preloaded in this process (it overwrites PEER_HEADER on every request). */
export function peerStampActive(): boolean {
  return (globalThis as Record<symbol, unknown>)[PEER_FLAG] === true;
}

/**
 * IRTC R1-05: the client address the proxy forwards to the API.
 * - `hops` >= 1 (behind that many trusted ingress proxies): the entry the outermost trusted proxy
 *   appended to X-Forwarded-For.
 * - `hops` = 0 (the web server is the edge): the TCP peer address stamped by the preload
 *   (`peer-address.cjs`), which overwrites any client-sent value. Without the preload there is no
 *   trustworthy source, so it fails safe to loopback (and the proxy logs it).
 */
export function clientAddress(h: Headers, hops: number = trustedProxyHops()): string {
  if (Number.isInteger(hops) && hops > 0) return forwardedClient(h.get('x-forwarded-for'), hops);
  if (!peerStampActive()) return '127.0.0.1';
  // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- anchored character class, at most 45 characters: linear time
  const peer = (h.get(PEER_HEADER) ?? '').trim();
  return IP_RE.test(peer) ? peer : '127.0.0.1';
}
