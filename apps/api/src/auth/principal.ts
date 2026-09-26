import type { Role } from '@kora/domain';

/** The authenticated caller, independent of which IdP issued the token (ADR 0101). */
export interface Principal {
  sub: string;
  email: string | null;
  roles: Role[];
  /** True when the session passed TOTP (amr contains "otp"). */
  mfa: boolean;
  tokenId: string | null;
  /** Token issue / expiry time in epoch seconds (goal 10 session revocation). */
  issuedAt?: number;
  expiresAt?: number;
}
