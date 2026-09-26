import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

/** Where the quant service lives. Read per call so tests and deployments can point it elsewhere. */
export function quantBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.QUANT_URL?.trim() || `http://127.0.0.1:${env.QUANT_PORT?.trim() || '8000'}`;
  return url.replace(/\/$/, '');
}

function timeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.QUANT_TIMEOUT_MS ?? '');
  return Number.isInteger(n) && n > 0 ? n : 20_000;
}

interface PydanticIssue {
  loc?: (string | number)[];
  msg?: string;
  type?: string;
}

/** Thin JSON client for services/quant. Maps failures to plain-language HTTP errors. */
@Injectable()
export class QuantClient {
  private readonly log = new Logger('QuantClient');

  async post<T>(path: string, body: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    const url = `${quantBaseUrl()}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? timeoutMs()),
      });
    } catch (err) {
      this.log.warn(`quant unreachable at ${path}: ${(err as Error).name}`);
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'quant_unavailable',
        message: 'The simulation service is not reachable right now. Nothing was simulated.',
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
        error: 'validation_failed',
        message: 'Request validation failed',
        issues,
      });
    }
    if (!res.ok) {
      this.log.error(`quant ${path} returned ${res.status}`);
      throw new BadGatewayException({
        statusCode: 502,
        error: 'quant_error',
        message: 'The simulation service failed. Nothing was simulated.',
      });
    }
    return data as T;
  }
}
