import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import { quantBaseUrl } from '../sim/quant.client';

interface PydanticIssue {
  loc?: (string | number)[];
  msg?: string;
  type?: string;
}

function timeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.KORA_BT_TIMEOUT_MS ?? '');
  return Number.isInteger(n) && n > 0 ? n : 120_000;
}

/**
 * JSON client for the quant research endpoints (`/bt/*`). Backtests and optimisations can take
 * longer than simulations, so the timeout is separate (`KORA_BT_TIMEOUT_MS`, default 120 s).
 */
@Injectable()
export class ResearchClient {
  private readonly log = new Logger('ResearchClient');

  async post<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${quantBaseUrl()}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs()),
      });
    } catch (err) {
      this.log.warn(`quant unreachable at ${path}: ${(err as Error).name}`);
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'quant_unavailable',
        message: 'The research service is not reachable right now. Nothing was run.',
      });
    }
    const text = await res.text();
    const data: unknown = text ? JSON.parse(text) : undefined;
    if (res.status === 422) {
      const detail = (data as { detail?: PydanticIssue[] | string } | undefined)?.detail;
      const issues = Array.isArray(detail)
        ? detail.map((d) => ({
            path: (d.loc ?? []).filter((p) => p !== 'body').join('.'),
            message: (d.msg ?? 'invalid').replace(/^Value error, /, ''),
            code: d.type ?? 'invalid',
          }))
        : [{ path: '', message: String(detail ?? 'invalid input'), code: 'invalid' }];
      throw new BadRequestException({
        statusCode: 400,
        error: issues.some((i) => i.code === 'look_ahead')
          ? 'look_ahead_detected'
          : 'research_rejected',
        message: issues[0]?.message ?? 'The research service rejected the request.',
        issues,
      });
    }
    if (!res.ok) {
      this.log.error(`quant ${path} returned ${res.status}`);
      throw new BadGatewayException({
        statusCode: 502,
        error: 'quant_error',
        message: 'The research service failed. Nothing was run.',
      });
    }
    return data as T;
  }
}
