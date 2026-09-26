import type {
  AuditEvent,
  ChainVerification,
  KillSwitchScope,
  OrderType,
  Role,
  UpdatePreferences,
  UserPreferences,
} from '@kora/domain';

export type { UpdatePreferences, UserPreferences };

export interface HealthCheck {
  status: 'up' | 'down' | 'skipped';
  latencyMs?: number;
  reason?: string;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: string;
  environment: 'PAPER' | 'LIVE';
  liveTradingEnabled: boolean;
  authProvider: 'dev' | 'keycloak';
  checks: { db: HealthCheck; redis: HealthCheck; keycloak: HealthCheck };
  time: string;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
}

export type LoginResponse =
  | { status: 'ok'; accessToken: string; user: PublicUser }
  | { status: 'mfa_required' | 'mfa_enrollment_required'; mfaToken: string };

export interface MfaEnrollResponse {
  secret: string;
  otpauthUrl: string;
}

export interface MfaVerifyResponse {
  status: 'ok';
  accessToken: string;
  user: PublicUser;
  enrolled: boolean;
}

export interface Capabilities {
  orderTypes: OrderType[];
  robotBuilder: boolean;
  auditReadAll: boolean;
  tradingEnvironment: 'PAPER' | 'LIVE';
}

export interface MeResponse {
  user: { id: string; email: string | null; displayName: string };
  roles: Role[];
  mfa: boolean;
  preferences: UserPreferences;
  capabilities: Capabilities;
}

export interface KillSwitchResponse {
  accepted: boolean;
  scope: KillSwitchScope;
  label: string;
  auditEventId: string;
  engine: string;
}

export interface AuditListQuery {
  actorId?: string;
  actorType?: AuditEvent['actorType'];
  entity?: string;
  entityId?: string;
  action?: string;
  from?: string;
  to?: string;
  beforeId?: string;
  limit?: number;
}

export interface AuditListResponse {
  events: AuditEvent[];
  nextBeforeId: string | null;
}

export type AuditVerifyResponse = ChainVerification;
