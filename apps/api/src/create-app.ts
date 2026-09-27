import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './config/config';
import { openApiSchema } from './common/zod';
import { CONTRACTS } from './contracts/registry';
import { httpMetrics } from './observability/http-metrics';
import { OpsMetrics } from './observability/ops-metrics.service';

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const doc = new DocumentBuilder()
    .setTitle('KORA API')
    .setDescription('KORA platform API (PAPER only). Money and prices are decimal strings.')
    .setVersion(API_VERSION)
    .addBearerAuth()
    .addCookieAuth('kora_at')
    .build();
  const document = SwaggerModule.createDocument(app, doc);
  // Goal 10: response contracts (B-004/B-209/B-312) from the same zod schemas the contract test uses.
  for (const [key, c] of Object.entries(CONTRACTS)) {
    const [method, path] = key.split(' ') as [string, string];
    const op = (document.paths[path] as Record<string, { responses?: Record<string, unknown> }> | undefined)?.[method.toLowerCase()];
    if (!op) throw new Error(`Contract for an unknown operation: ${key}`);
    const schema = openApiSchema(c.schema, 'output');
    op.responses = { ...(op.responses ?? {}), [String(c.status)]: { description: 'Success', content: { 'application/json': { schema } } } };
  }
  return document;
}

/** Release version of the API contract (goal 10: 1.0.0-rc.1). */
export const API_VERSION = '1.0.0-rc.1';

export async function createApp(opts: { logger?: boolean } = {}): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  if (opts.logger !== false) app.useLogger(app.get(Logger));
  // Goal 10 (B-015): which upstream proxies may set X-Forwarded-For (Express syntax, e.g. 'loopback, 10.0.0.0/8').
  app.set('trust proxy', process.env.KORA_API_TRUST_PROXY?.trim() || 'loopback');
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"] },
      },
    }),
  );
  app.use(cookieParser());
  app.use(httpMetrics(app.get(OpsMetrics)));
  app.enableShutdownHooks();
  // IRTC R1-11: API docs only in dev and test (they were also exposed in staging).
  if (app.get<AppConfig>(APP_CONFIG).apiDocs) {
    SwaggerModule.setup('docs', app, buildOpenApi(app), { jsonDocumentUrl: 'openapi.json' });
  }
  return app;
}
