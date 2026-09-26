import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { GOVERNANCE_CONFIG, type GovernanceConfig } from './governance-config';

/**
 * Change-management evidence (goal 09, KC-11): every api start records the build it runs and the
 * deployment approval reference supplied by the release pipeline (KORA_BUILD_SHA,
 * KORA_RELEASE_APPROVAL_REF). A start outside dev/test without an approval reference is an exception
 * the control reports.
 */
@Injectable()
export class ReleaseRecordService implements OnApplicationBootstrap {
  private readonly log = new Logger('ReleaseRecord');

  constructor(
    @Inject(GOVERNANCE_CONFIG) private readonly cfg: GovernanceConfig,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.cfg.releaseRecord) return;
    try {
      await this.audit.record({
        actorId: 'release',
        actorType: 'system',
        action: 'system.release_started',
        entity: 'release',
        entityId: this.cfg.buildSha || 'unversioned',
        payload: {
          environment: this.cfg.env,
          buildSha: this.cfg.buildSha || null,
          approvalRef: this.cfg.releaseApprovalRef || null,
          version: process.env.npm_package_version ?? null,
          tradingEnvironment: 'PAPER',
        },
      });
      if (!this.cfg.releaseApprovalRef && this.cfg.env !== 'dev' && this.cfg.env !== 'test')
        this.log.warn('KORA_RELEASE_APPROVAL_REF is empty: this release is reported as an exception by control KC-11');
    } catch (e) {
      // The schema may not be migrated yet (e2e starts the api before migrating); never block boot.
      this.log.warn(`release record skipped: ${(e as Error).message}`);
    }
  }
}
