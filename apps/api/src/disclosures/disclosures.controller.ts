import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { DisclosureAcknowledgements } from './acknowledgements.service';
import { ACK_CONTEXTS, DISCLOSURE_LOCALES, type DisclosureLocale } from './disclosure.types';

const IdParam = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const LocaleQuery = z.strictObject({ locale: z.enum(DISCLOSURE_LOCALES).optional() });
const AckSchema = z.strictObject({
  version: z.string().min(1).max(64),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  locale: z.enum(DISCLOSURE_LOCALES),
  context: z.enum(ACK_CONTEXTS).default('onboarding'),
});

/**
 * Regulatory disclosures (goal 08; goal 09 owns the registry). Values set by Compliance are rendered
 * server-side; placeholders stay visible until the Sponsor supplies them (OQ-R1).
 */
@ApiTags('disclosures')
@Controller('disclosures')
export class DisclosuresController {
  constructor(private readonly acks: DisclosureAcknowledgements) {}

  @Get(':id')
  @ApiOperation({
    summary:
      'The disclosure in force (rendered with the Compliance-set values, e.g. the retail-loss %) and whether you acknowledged this version.',
  })
  @ApiQuery({ name: 'locale', required: false, enum: DISCLOSURE_LOCALES })
  async get(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ZodValidationPipe(IdParam)) id: string,
    @Query(new ZodValidationPipe(LocaleQuery)) q: { locale?: DisclosureLocale },
  ) {
    const doc = this.acks.document(id, q.locale ?? 'en');
    return {
      document: doc,
      acknowledged: await this.acks.isCurrent(p.sub, id),
      lastAcknowledgement: await this.acks.latest(p.sub, id),
    };
  }

  @Post(':id/acknowledgements')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Acknowledge the version you read (version + content hash). 409 when the text changed since. Stored append-only and audited.',
  })
  @ApiBody({ schema: openApiSchema(AckSchema) })
  async acknowledge(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ZodValidationPipe(IdParam)) id: string,
    @Body(new ZodValidationPipe(AckSchema)) body: z.infer<typeof AckSchema>,
  ) {
    return { acknowledgement: await this.acks.record(p.sub, id, body), acknowledged: true };
  }
}
