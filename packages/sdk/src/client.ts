import type { KillSwitchScope } from '@kora/domain';

import type {
  AuditListQuery,
  AuditListResponse,
  AuditVerifyResponse,
  Capabilities,
  HealthResponse,
  KillSwitchResponse,
  LoginResponse,
  MeResponse,
  MfaEnrollResponse,
  MfaVerifyResponse,
  PublicUser,
  UpdatePreferences,
  UserPreferences,
} from './types.js';

export class KoraApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'KoraApiError';
  }
}

export interface KoraClientOptions {
  /** e.g. "/api" in the browser (Next rewrite) or "http://127.0.0.1:4000" server-side. */
  baseUrl: string;
  /** Bearer token for non-browser clients. Browsers rely on the HttpOnly cookie. */
  token?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

/** Typed KORA API client (hand-written stub; generated from OpenAPI in goal 03, BACKLOG B-004). */
export class KoraClient {
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(private readonly opts: KoraClientOptions) {
    this.base = opts.baseUrl.replace(/\/$/, '');
    this.f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  withToken(token: string): KoraClient {
    return new KoraClient({ ...this.opts, token });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', 'x-kora-csrf': '1', ...this.opts.headers };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    const res = await this.f(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'include',
      cache: 'no-store',
    });
    const text = await res.text();
    const data: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const b = (data ?? {}) as { error?: string; message?: string | string[] };
      const message = Array.isArray(b.message) ? b.message.join(', ') : (b.message ?? res.statusText);
      throw new KoraApiError(res.status, b.error ?? `http_${res.status}`, message, data);
    }
    return data as T;
  }

  health() {
    return this.request<HealthResponse>('GET', '/health');
  }

  signup(input: { email: string; password: string; displayName: string; accountType: 'novice' | 'trader' }) {
    return this.request<{ user: PublicUser; mfaRequired: boolean }>('POST', '/auth/signup', input);
  }

  login(email: string, password: string) {
    return this.request<LoginResponse>('POST', '/auth/login', { email, password });
  }

  mfaEnroll(mfaToken: string) {
    return this.request<MfaEnrollResponse>('POST', '/auth/mfa/enroll', { mfaToken });
  }

  mfaVerify(mfaToken: string, code: string) {
    return this.request<MfaVerifyResponse>('POST', '/auth/mfa/verify', { mfaToken, code });
  }

  logout() {
    return this.request<{ status: 'ok' }>('POST', '/auth/logout');
  }

  me() {
    return this.request<MeResponse>('GET', '/me');
  }

  preferences() {
    return this.request<UserPreferences>('GET', '/me/preferences');
  }

  updatePreferences(patch: UpdatePreferences) {
    return this.request<{ preferences: UserPreferences; capabilities: Capabilities }>('PUT', '/me/preferences', patch);
  }

  killSwitch(scope: KillSwitchScope, source: 'ui_button' | 'hotkey' | 'rest_fallback' = 'ui_button') {
    return this.request<KillSwitchResponse>('POST', '/kill-switch', { scope, source });
  }

  audit(q: AuditListQuery = {}) {
    const qs = new URLSearchParams(
      Object.entries(q)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    return this.request<AuditListResponse>('GET', `/audit${qs ? `?${qs}` : ''}`);
  }

  verifyAudit() {
    return this.request<AuditVerifyResponse>('GET', '/audit/verify');
  }
}
