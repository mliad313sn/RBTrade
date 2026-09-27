import type { ZodType } from 'zod';

import * as S from './schemas';

export interface Contract {
  status: number;
  schema: ZodType;
  /** Consumer that relies on it (documentation for the contract test report). */
  consumers: Array<'web' | 'sdk' | 'bot-runner'>;
}

/**
 * Response contracts by operation (`METHOD /openapi/path`). Merged into the OpenAPI document by
 * `buildOpenApi`; `test/contracts.int.test.ts` calls every one of them and validates the live
 * response against the generated document.
 */
export const CONTRACTS: Record<string, Contract> = {
  'GET /health': { status: 200, schema: S.HealthSchema, consumers: ['web', 'sdk'] },
  'POST /auth/login': { status: 200, schema: S.LoginResponseSchema, consumers: ['web', 'sdk'] },
  'GET /me': { status: 200, schema: S.MeSchema, consumers: ['web', 'sdk'] },
  'GET /audit': { status: 200, schema: S.AuditListSchema, consumers: ['web', 'sdk'] },
  'GET /audit/verify': {
    status: 200,
    schema: S.ChainVerificationSchema,
    consumers: ['web', 'sdk'],
  },
  'GET /instruments': { status: 200, schema: S.InstrumentsSchema, consumers: ['web', 'sdk'] },
  'GET /instruments/{symbol}': {
    status: 200,
    schema: S.InstrumentDetailSchema,
    consumers: ['web', 'sdk'],
  },
  'GET /venues': { status: 200, schema: S.VenuesSchema, consumers: ['web', 'sdk'] },
  'GET /candles': { status: 200, schema: S.CandlesSchema, consumers: ['web', 'sdk'] },
  'GET /quotes': { status: 200, schema: S.QuotesSchema, consumers: ['web', 'sdk'] },
  'GET /market-data/status': {
    status: 200,
    schema: S.MarketStatusSchema,
    consumers: ['web', 'sdk'],
  },
  'POST /orders/preview': { status: 200, schema: S.PreviewSchema, consumers: ['web', 'sdk'] },
  'POST /orders': { status: 201, schema: S.PlaceOrderSchema, consumers: ['web', 'sdk'] },
  'GET /orders': { status: 200, schema: S.OrderListSchema, consumers: ['web', 'sdk'] },
  'GET /orders/{id}': { status: 200, schema: S.OrderDetailSchema, consumers: ['web', 'sdk'] },
  'PATCH /orders/{id}': { status: 200, schema: S.OrderSchema, consumers: ['web', 'sdk'] },
  'DELETE /orders/{id}': { status: 200, schema: S.OrderSchema, consumers: ['web', 'sdk'] },
  'GET /positions': { status: 200, schema: S.PositionsSchema, consumers: ['web', 'sdk'] },
  'GET /fills': { status: 200, schema: S.FillsSchema, consumers: ['web', 'sdk'] },
  'GET /accounts/me': { status: 200, schema: S.AccountSchema, consumers: ['web', 'sdk'] },
  'GET /alerts': { status: 200, schema: S.AlertsSchema, consumers: ['web', 'sdk'] },
  'POST /kill-switch': { status: 202, schema: S.KillSwitchSchema, consumers: ['web', 'sdk'] },
  'GET /kill-switch': { status: 200, schema: S.KillSwitchStateSchema, consumers: ['web', 'sdk'] },
  'POST /kill-switch/resume': { status: 200, schema: S.ResumeSchema, consumers: ['web', 'sdk'] },
  'GET /appropriateness/questionnaire': {
    status: 200,
    schema: S.QuestionnaireSchema,
    consumers: ['web', 'sdk'],
  },
  'GET /strategy-templates': { status: 200, schema: S.TemplatesSchema, consumers: ['web'] },
  'GET /strategies': { status: 200, schema: S.StrategiesSchema, consumers: ['web'] },
  'POST /strategies/validate': {
    status: 200,
    schema: S.ValidateStrategySchema,
    consumers: ['web'],
  },
  'GET /robots': { status: 200, schema: S.RobotsSchema, consumers: ['web'] },
  'GET /disclosures/{id}': { status: 200, schema: S.DisclosureSchema, consumers: ['web', 'sdk'] },
  'GET /ai/status': { status: 200, schema: S.AiStatusSchema, consumers: ['web'] },
};
