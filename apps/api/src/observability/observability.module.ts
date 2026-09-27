import { Global, Module } from '@nestjs/common';

import { GovernanceHealthMetrics } from './governance-health.metrics';
import { MetricsRegistry, OpsMetrics } from './ops-metrics.service';

@Global()
@Module({ providers: [MetricsRegistry, OpsMetrics, GovernanceHealthMetrics], exports: [MetricsRegistry, OpsMetrics] })
export class ObservabilityModule {}
