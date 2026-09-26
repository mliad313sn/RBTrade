import type { KillSwitchScope } from '@kora/domain';

import type { DepthSnapshot, Timeframe } from '@kora/domain';

import type {
  CalendarResponse,
  CandlesResponse,
  InstrumentDetail,
  InstrumentDto,
  InstrumentsQuery,
  MarketStatusResponse,
  QuotesResponse,
  AuditListQuery,
  AuditListResponse,
  AuditVerifyResponse,
  Capabilities,
  HealthResponse,
  KillSwitchResponse,
  KillSwitchState,
  AccountView,
  AccountSettingsPatch,
  PreviewInput,
  PreviewResponse,
  OrderInput,
  PlaceOrderResponse,
  OrderDto,
  OrderDetail,
  PositionDto,
  FillDto,
  QuestionnaireResponse,
  AttemptResponse,
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

/** Typed KORA API client (hand-written, mirrored by packages/sdk/openapi.json; generation is B-004). */
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

  /** Everyone signs up as novice (B-018); Pro trading needs the appropriateness assessment. */
  signup(input: { email: string; password: string; displayName: string }) {
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

  killSwitch(scope: KillSwitchScope, source: 'ui_button' | 'hotkey' | 'rest_fallback' = 'ui_button', reason?: string) {
    return this.request<KillSwitchResponse>('POST', '/kill-switch', { scope, source, ...(reason ? { reason } : {}) });
  }

  killSwitchState() {
    return this.request<KillSwitchState>('GET', '/kill-switch');
  }

  resumeTrading(reason: string, accountId?: string) {
    return this.request<{ resumed: true; accountId: string; previous: { scope: KillSwitchScope | null; haltedAt: string | null; haltedBy: string | null } }>(
      'POST',
      `/kill-switch/resume${query({ accountId })}`,
      { reason },
    );
  }

  // ---- trading (goal 03) ----

  account() {
    return this.request<AccountView>('GET', '/accounts/me');
  }

  updateAccountSettings(patch: AccountSettingsPatch) {
    return this.request<AccountView>('PUT', '/accounts/me/settings', patch);
  }

  previewOrder(body: PreviewInput) {
    return this.request<PreviewResponse>('POST', '/orders/preview', body);
  }

  /** Throws KoraApiError(422, code) with a RiskRejectionBody on a risk rejection. */
  placeOrder(body: OrderInput) {
    return this.request<PlaceOrderResponse>('POST', '/orders', body);
  }

  orders(q: { status?: 'open' | 'all'; symbol?: string; limit?: number; before?: string } = {}) {
    return this.request<{ accountId: string; orders: OrderDto[] }>('GET', `/orders${query(q)}`);
  }

  order(id: string) {
    return this.request<OrderDetail>('GET', `/orders/${encodeURIComponent(id)}`);
  }

  amendOrder(id: string, patch: { qty?: string; limitPrice?: string; stopPrice?: string; trailAmount?: string }) {
    return this.request<OrderDto>('PATCH', `/orders/${encodeURIComponent(id)}`, patch);
  }

  cancelOrder(id: string) {
    return this.request<OrderDto>('DELETE', `/orders/${encodeURIComponent(id)}`);
  }

  positions() {
    return this.request<{ accountId: string; currency: string; positions: PositionDto[] }>('GET', '/positions');
  }

  closePosition(symbol: string) {
    return this.request<PlaceOrderResponse>('POST', `/positions/${encodeURIComponent(symbol)}/close`);
  }

  fills(q: { limit?: number; before?: string; symbol?: string } = {}) {
    return this.request<{ accountId: string; currency: string; fills: FillDto[] }>('GET', `/fills${query(q)}`);
  }

  // ---- appropriateness (B-018) ----

  appropriateness() {
    return this.request<QuestionnaireResponse>('GET', '/appropriateness/questionnaire');
  }

  submitAppropriateness(questionnaireId: string, version: number, answers: Record<string, string>) {
    return this.request<AttemptResponse>('POST', '/appropriateness/attempts', { questionnaireId, version, answers });
  }

  audit(q: AuditListQuery = {}) {
    return this.request<AuditListResponse>('GET', `/audit${query(q)}`);
  }

  // ---- market data (goal 02) ----

  instruments(q: InstrumentsQuery = {}) {
    return this.request<{ instruments: InstrumentDto[] }>('GET', `/instruments${query(q)}`);
  }

  instrument(symbol: string) {
    return this.request<InstrumentDetail>('GET', `/instruments/${encodeURIComponent(symbol)}`);
  }

  candles(q: { symbol: string; tf: Timeframe; limit?: number; from?: number; to?: number }) {
    return this.request<CandlesResponse>('GET', `/candles${query(q)}`);
  }

  quotes(symbols: string[]) {
    return this.request<QuotesResponse>('GET', `/quotes${query({ symbols: symbols.join(',') })}`);
  }

  depth(symbol: string) {
    return this.request<{ symbol: string; depth: DepthSnapshot | null }>('GET', `/depth/${encodeURIComponent(symbol)}`);
  }

  marketStatus() {
    return this.request<MarketStatusResponse>('GET', '/market-data/status');
  }

  calendar(q: { from?: number; to?: number } = {}) {
    return this.request<CalendarResponse>('GET', `/calendar${query(q)}`);
  }

  verifyAudit() {
    return this.request<AuditVerifyResponse>('GET', '/audit/verify');
  }
}

function query(q: object): string {
  const qs = new URLSearchParams(
    Object.entries(q)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  return qs ? `?${qs}` : '';
}
