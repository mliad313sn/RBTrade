import { type ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Response } from 'express';

/** Logs unexpected errors (never their payloads to the client) and returns a stable error shape. */
@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  private readonly log = new Logger('Unhandled');

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof HttpException) return super.catch(exception, host);
    const err = exception as Error;
    this.log.error(err.message, err.stack);
    if (process.env.KORA_TEST_LOGS === '1') console.error(err);
    const res = host.switchToHttp().getResponse<Response>();
    res.status(500).json({
      statusCode: 500,
      error: 'internal_error',
      message: 'Something went wrong. It has been logged.',
    });
  }
}
