/**
 * Gain simulator wire types now live in the typed SDK (B-506, `packages/sdk/src/sim-types.ts`).
 * Re-exported here so the simulator and Practice components keep their imports.
 */
export type {
  Histogram,
  PaperAnalytics,
  PaperProjection,
  PaperProjectRequest,
  PaperSource,
  ProjectRequest,
  RealityCheck,
  SavedScenario,
  Scenario,
  Severity,
  SimResult,
  SizingModel,
} from '@kora/sdk';
