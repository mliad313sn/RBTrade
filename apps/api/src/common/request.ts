import type { Request } from 'express';

import type { Principal } from '../auth/principal';

export interface KoraRequest extends Request {
  principal?: Principal;
  cookies: Record<string, string | undefined>;
}

export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
