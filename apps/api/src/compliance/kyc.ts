/**
 * KYC provider interface (goal 09): **stub only**. No identity checks run in this build; the stub
 * refuses and reports `not_configured`. A real provider needs a contract and a data-processing
 * agreement (Sponsor, OQ-K1) and plugs in behind this interface.
 */
export type KycStatus = 'not_configured' | 'not_started' | 'pending' | 'verified' | 'rejected';

export interface KycCheckRequest {
  userId: string;
  /** Jurisdiction whose rules apply (placeholder until OQ-R2). */
  jurisdiction: string;
}

export interface KycCheckResult {
  status: KycStatus;
  provider: string;
  reference: string | null;
  checkedAt: string | null;
  reason: string | null;
}

export interface KycProvider {
  readonly id: string;
  readonly flagged: boolean;
  readonly licensed: boolean;
  describe(): { id: string; name: string; flagged: boolean; licensed: boolean; capabilities: string[]; note: string };
  start(req: KycCheckRequest): Promise<KycCheckResult>;
  status(userId: string): Promise<KycCheckResult>;
}

export class KycNotConfiguredError extends Error {}

/** Flagged stub: every call refuses; nothing leaves the platform. */
export class StubKycProvider implements KycProvider {
  readonly id = 'kyc-stub';
  readonly flagged = true;
  readonly licensed = false;

  describe() {
    return {
      id: this.id,
      name: 'KYC provider (stub)',
      flagged: true,
      licensed: false,
      capabilities: ['identity document', 'liveness', 'sanctions/PEP screening', 'address'],
      note: 'Stub only: no provider is contracted (OQ-K1). PAPER accounts do not need KYC; LIVE accounts would.',
    };
  }

  async start(_req: KycCheckRequest): Promise<KycCheckResult> {
    throw new KycNotConfiguredError('No KYC provider is configured (stub). Nothing was sent.');
  }

  async status(_userId: string): Promise<KycCheckResult> {
    return { status: 'not_configured', provider: this.id, reference: null, checkedAt: null, reason: 'No KYC provider is contracted yet (OQ-K1).' };
  }
}

export const KYC_PROVIDER = Symbol('KYC_PROVIDER');
