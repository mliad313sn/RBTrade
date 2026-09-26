import { Global, Module } from '@nestjs/common';

import { FourEyesStore } from './four-eyes.store';
import { GOVERNANCE_CONFIG, loadGovernanceConfig } from './governance-config';

/**
 * Governance primitives every module may use (goal 09): the settings and the four-eyes store. Global
 * so the trading core can open a four-eyes request (kill-switch resume) without importing the
 * governance module, which itself depends on trading.
 */
@Global()
@Module({
  providers: [{ provide: GOVERNANCE_CONFIG, useFactory: () => loadGovernanceConfig(process.env) }, FourEyesStore],
  exports: [GOVERNANCE_CONFIG, FourEyesStore],
})
export class GovernanceCoreModule {}
