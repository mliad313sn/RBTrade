import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import knowledgeCheckV1 from '../src/appropriateness/questionnaires/knowledge-check.v1.json';
import { bearer, failingAnswers, passingAnswers } from './helpers';

/** Knowledge check answers from the reviewed data file (graded through the real API). */
export const knowledgePass = () => passingAnswers(knowledgeCheckV1);
export const knowledgeFail = () => failingAnswers(knowledgeCheckV1);

export async function passKnowledgeCheck(app: INestApplication, token: string): Promise<void> {
  const res = await request(app.getHttpServer())
    .post('/novice/knowledge-check/attempts')
    .set(bearer(token))
    .send({
      questionnaireId: knowledgeCheckV1.id,
      version: knowledgeCheckV1.version,
      answers: knowledgePass(),
    })
    .expect(200);
  if (!res.body.passed) throw new Error(`knowledge check not passed: ${JSON.stringify(res.body)}`);
}

/** Onboarding through the API: acknowledge the risk warning, set both limits, complete. */
export async function onboard(
  app: INestApplication,
  token: string,
  limits = { dailyLossLimit: '1500', monthlyLossLimit: '6000' },
) {
  const http = app.getHttpServer();
  const doc = await request(http)
    .get('/disclosures/risk-warning?locale=en')
    .set(bearer(token))
    .expect(200);
  await request(http)
    .post('/disclosures/risk-warning/acknowledgements')
    .set(bearer(token))
    .send({
      version: doc.body.document.version,
      contentHash: doc.body.document.contentHash,
      locale: 'en',
    })
    .expect(201);
  await request(http).put('/novice/limits').set(bearer(token)).send(limits).expect(200);
  return (await request(http).post('/novice/onboarding/complete').set(bearer(token)).expect(200))
    .body;
}
