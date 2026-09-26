import type { KillSwitchScope } from '@kora/domain';

import type { CreateAlert, DepthSnapshot, PriceAlertDto, Timeframe, WatchlistDto } from '@kora/domain';

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
  SavedLayout,
  RiskSummary,
  VenueDto,
  LoginResponse,
  MeResponse,
  MfaEnrollResponse,
  MfaRecoveryResponse,
  MfaVerifyResponse,
  UpdatePreferences,
  UserPreferences,
} from './types.js';
import type { PaperAnalytics, PaperProjection, PaperProjectRequest, ProjectRequest, SavedScenario, SimResult } from './sim-types.js';
import type {
  AutoInvestList,
  DisclosureAcknowledgement,
  DisclosureLocale,
  DisclosureResponse,
  KnowledgeAttemptResponse,
  KnowledgeCheckResponse,
  MfaOptInResponse,
  NoviceAsset,
  NoviceProfile,
  NoviceSummary,
  NoviceTicketRequest,
  NoviceTicketResponse,
} from './novice-types.js';

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
    return this.request<{ accepted: true; mfaRequired: boolean; next: 'sign_in' }>('POST', '/auth/signup', input);
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

  /** B-902: second factor with a one-time recovery code. */
  mfaRecovery(mfaToken: string, recoveryCode: string) {
    return this.request<MfaRecoveryResponse>('POST', '/auth/mfa/recovery', { mfaToken, recoveryCode });
  }

  /** B-902: replace the recovery codes (needs a fresh 6-digit code). */
  regenerateRecoveryCodes(code: string) {
    return this.request<{ recoveryCodes: string[] }>('POST', '/auth/mfa/recovery-codes', { code });
  }

  recoveryCodesStatus() {
    return this.request<{ remaining: number }>('GET', '/auth/mfa/recovery-codes');
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
    return this.request<
      | { resumed: true; accountId: string; previous: { scope: KillSwitchScope | null; haltedAt: string | null; haltedBy: string | null } }
      // Goal 09: a firm halt answers 202 with a four-eyes request a second person approves.
      | { resumed: false; accountId: string; pendingApproval: { id: string; status: string; requestedBy: string; expiresAt: string }; message: string }
    >(
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

  /** Cancels every open order (optionally one symbol) through the engine; each cancel is audited. */
  cancelAllOrders(symbol?: string) {
    return this.request<{ accountId: string; cancelled: number; orders: OrderDto[] }>('DELETE', `/orders${query({ symbol })}`);
  }

  // ---- Pro terminal (goal 04) ----

  layouts() {
    return this.request<{ layouts: SavedLayout[] }>('GET', '/me/layouts');
  }

  saveLayout(name: string, layout: Record<string, unknown>) {
    return this.request<SavedLayout>('PUT', `/me/layouts/${encodeURIComponent(name)}`, { layout });
  }

  deleteLayout(name: string) {
    return this.request<void>('DELETE', `/me/layouts/${encodeURIComponent(name)}`);
  }

  watchlists() {
    return this.request<{ watchlists: WatchlistDto[] }>('GET', '/me/watchlists');
  }

  createWatchlist(name: string, symbols: string[] = []) {
    return this.request<WatchlistDto>('POST', '/me/watchlists', { name, symbols });
  }

  updateWatchlist(id: string, patch: { name?: string; symbols?: string[]; position?: number }) {
    return this.request<WatchlistDto>('PUT', `/me/watchlists/${encodeURIComponent(id)}`, patch);
  }

  deleteWatchlist(id: string) {
    return this.request<void>('DELETE', `/me/watchlists/${encodeURIComponent(id)}`);
  }

  priceAlerts(q: { status?: 'active' | 'all'; limit?: number } = {}) {
    return this.request<{ alerts: PriceAlertDto[] }>('GET', `/price-alerts${query(q)}`);
  }

  createPriceAlert(body: CreateAlert) {
    return this.request<PriceAlertDto>('POST', '/price-alerts', body);
  }

  cancelPriceAlert(id: string) {
    return this.request<PriceAlertDto>('DELETE', `/price-alerts/${encodeURIComponent(id)}`);
  }

  riskSummary() {
    return this.request<RiskSummary>('GET', '/risk/summary');
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

  /** Venues (ISO 10383 MIC, region, timezone, calendar) with their current session. */
  venues() {
    return this.request<{ venues: VenueDto[] }>('GET', '/venues');
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

  // ---- gain simulator (goal 05; typed in goal 08, B-506) ----

  simProject(body: ProjectRequest) {
    return this.request<SimResult>('POST', '/sim/project', body);
  }

  /** Block bootstrap of a trade list (goal 06 backtests send their OOS R multiples here). */
  simFromTrades(body: Record<string, unknown>) {
    return this.request<SimResult>('POST', '/sim/from-trades', body);
  }

  simPaperAnalytics() {
    return this.request<{ source: PaperProjection['source']; analytics: PaperAnalytics }>('GET', '/sim/paper/analytics');
  }

  simPaperProject(body: PaperProjectRequest) {
    return this.request<PaperProjection>('POST', '/sim/paper/project', body);
  }

  /** B-505: saved, named scenarios. */
  simScenarios(kind?: 'practice' | 'pro') {
    return this.request<{ scenarios: SavedScenario[]; max: number }>('GET', `/sim/scenarios${query({ kind })}`);
  }

  saveSimScenario(body: { kind: 'practice' | 'pro'; name: string; input: Record<string, unknown>; overwrite?: boolean }) {
    return this.request<SavedScenario>('POST', '/sim/scenarios', body);
  }

  deleteSimScenario(id: string) {
    return this.request<{ deleted: true; id: string }>('DELETE', `/sim/scenarios/${encodeURIComponent(id)}`);
  }

  // ---- Novice view (goal 08) ----

  noviceProfile() {
    return this.request<NoviceProfile>('GET', '/novice/profile');
  }

  completeOnboarding() {
    return this.request<NoviceProfile>('POST', '/novice/onboarding/complete');
  }

  /** Tightening applies now; in the Novice view a loosening waits 24 h (server rule). */
  setNoviceLimits(body: { dailyLossLimit?: string; monthlyLossLimit?: string }) {
    return this.request<NoviceProfile>('PUT', '/novice/limits', body);
  }

  setNoviceLeverage(enabled: boolean) {
    return this.request<NoviceProfile>('PUT', '/novice/leverage', { enabled });
  }

  noviceSummary() {
    return this.request<NoviceSummary>('GET', '/novice/summary');
  }

  noviceAssets() {
    return this.request<{ currency: string; assets: NoviceAsset[]; simulated: true }>('GET', '/novice/assets');
  }

  /** Builds the novice order and returns the unchanged /orders/preview answer for it. */
  noviceTicket(body: NoviceTicketRequest) {
    return this.request<NoviceTicketResponse>('POST', '/novice/ticket', body);
  }

  knowledgeCheck() {
    return this.request<KnowledgeCheckResponse>('GET', '/novice/knowledge-check');
  }

  submitKnowledgeCheck(questionnaireId: string, version: number, answers: Record<string, string>) {
    return this.request<KnowledgeAttemptResponse>('POST', '/novice/knowledge-check/attempts', { questionnaireId, version, answers });
  }

  autoInvest() {
    return this.request<AutoInvestList>('GET', '/novice/auto-invest');
  }

  startAutoInvest(templateId: string, amount: string) {
    return this.request<AutoInvestList>('POST', '/novice/auto-invest', { templateId, amount });
  }

  pauseAutoInvest(robotId: string) {
    return this.request<AutoInvestList>('POST', `/novice/auto-invest/${encodeURIComponent(robotId)}/pause`);
  }

  resumeAutoInvest(robotId: string) {
    return this.request<AutoInvestList>('POST', `/novice/auto-invest/${encodeURIComponent(robotId)}/resume`);
  }

  disclosure(id: string, locale: DisclosureLocale = 'en') {
    return this.request<DisclosureResponse>('GET', `/disclosures/${encodeURIComponent(id)}${query({ locale })}`);
  }

  acknowledgeDisclosure(
    id: string,
    body: { version: string; contentHash: string; locale: DisclosureLocale; context?: DisclosureAcknowledgement['context'] },
  ) {
    return this.request<{ acknowledgement: DisclosureAcknowledgement; acknowledged: true }>(
      'POST',
      `/disclosures/${encodeURIComponent(id)}/acknowledgements`,
      body,
    );
  }

  /** B-017: optional two-step sign-in; finish with mfaVerify(mfaToken, code). */
  mfaOptIn() {
    return this.request<MfaOptInResponse>('POST', '/auth/mfa/opt-in');
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
