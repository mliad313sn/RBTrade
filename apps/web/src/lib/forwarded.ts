/**
 * Client address forwarded to the API (goal 10, B-015).
 *
 * The web `/api` proxy must never pass a client-chosen `X-Forwarded-For` value on: the API keys
 * per-IP rate limits and audit IPs on it. Only entries appended by proxies we operate are trusted:
 * with `hops` trusted proxies in front of the web server (`KORA_TRUSTED_PROXY_HOPS`, e.g. 1 behind
 * one ingress), the client address is the `hops`-th entry from the right. With 0 (the default: no
 * trusted proxy configured) the header is ignored and every caller is reported as the loopback
 * address, which fails safe (shared, stricter limits) instead of letting a client pick its IP.
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
