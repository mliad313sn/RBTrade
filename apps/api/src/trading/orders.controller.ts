import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  AmendOrderSchema,
  PlaceOrderSchema,
  PreviewOrderSchema,
  SYMBOL_RE,
  type AmendOrderRequest,
  type PlaceOrderRequest,
  type PreviewOrderRequest,
} from '@kora/domain';
import type { Response } from 'express';
import { z } from 'zod';

import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { OmsService } from './oms.service';

/** Order endpoints per client per minute (KORA_ORDER_RATE_LIMIT, ASVS rate limit on order endpoints). */
export const orderThrottle = () => ({
  default: { limit: () => Number(process.env.KORA_ORDER_RATE_LIMIT ?? 600) || 600, ttl: 60_000 },
});

const ListQuery = z
  .object({
    status: z.enum(['open', 'all']).default('open'),
    symbol: z.string().regex(SYMBOL_RE).optional(),
    limit: z.coerce.number().int().min(1).max(2000).optional(),
    before: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

const CancelAllQuery = z.object({ symbol: z.string().regex(SYMBOL_RE).optional() }).strict();

@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly oms: OmsService) {}

  @Post('preview')
  @HttpCode(200)
  @Throttle(orderThrottle())
  @ApiOperation({
    summary:
      'Order preview: notional, fees + spread, FX conversion, margin impact, loss if the stop is hit (currency and % of equity), reward:risk, confirmation flag and the pre-trade risk verdict. PAPER, SIMULATED.',
  })
  @ApiBody({ schema: openApiSchema(PreviewOrderSchema) })
  preview(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(PreviewOrderSchema)) body: PreviewOrderRequest,
  ) {
    return this.oms.preview(p.sub, p.roles, body);
  }

  @Post()
  @Throttle(orderThrottle())
  @ApiOperation({
    summary:
      'Place a paper order. Idempotent on clientOrderId (201 new, 200 replay, 409 reused with a different body). Risk rejections return 422 with a machine code and a plain-language message.',
  })
  @ApiBody({ schema: openApiSchema(PlaceOrderSchema) })
  async place(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(PlaceOrderSchema)) body: PlaceOrderRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.oms.submit(
      { userId: p.sub, roles: p.roles, actor: { type: 'user', id: p.sub }, source: body.source },
      body,
    );
    res.status(out.idempotentReplay ? 200 : 201);
    return out;
  }

  @Get()
  @ApiOperation({ summary: 'List orders (open by default), newest first.' })
  @ApiQuery({ name: 'status', required: false, enum: ['open', 'all'] })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'before', required: false })
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodValidationPipe(ListQuery)) q: z.infer<typeof ListQuery>,
  ) {
    return this.oms.list(p.sub, q);
  }

  @Delete()
  @Throttle(orderThrottle())
  @ApiOperation({
    summary: 'Cancel every open order, optionally for one symbol (Pro terminal "Cancel all"; each cancel is audited).',
  })
  @ApiQuery({ name: 'symbol', required: false })
  cancelAll(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodValidationPipe(CancelAllQuery)) q: z.infer<typeof CancelAllQuery>,
  ) {
    return this.oms.cancelAll(p.sub, q.symbol, p.roles);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One order with its children (bracket stop/target, OCO legs).' })
  get(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.oms.get(p.sub, id);
  }

  @Patch(':id')
  @Throttle(orderThrottle())
  @ApiOperation({
    summary: 'Amend quantity, limit, stop or trailing distance of a working order (audited).',
  })
  @ApiBody({ schema: openApiSchema(AmendOrderSchema) })
  amend(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(AmendOrderSchema)) body: AmendOrderRequest,
  ) {
    return this.oms.amend(p.sub, p.roles, id, body);
  }

  @Delete(':id')
  @Throttle(orderThrottle())
  @ApiOperation({
    summary: 'Cancel an open order (audited). Cancelling an OCO group cancels its legs.',
  })
  cancel(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.oms.cancel(p.sub, id, 'user_requested', { type: 'user', id: p.sub }, p.roles);
  }
}
