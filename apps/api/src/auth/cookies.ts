import type { Response } from 'express';

import type { AppConfig } from '../config/config';

export const ACCESS_COOKIE = 'kora_at';

export function setAccessCookie(res: Response, token: string, config: AppConfig): void {
  res.cookie(ACCESS_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.auth.secureCookies,
    path: '/',
    maxAge: config.auth.accessTokenTtlSeconds * 1000,
  });
}

export function clearAccessCookie(res: Response, config: AppConfig): void {
  res.clearCookie(ACCESS_COOKIE, { httpOnly: true, sameSite: 'strict', secure: config.auth.secureCookies, path: '/' });
}
