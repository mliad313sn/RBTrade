// Goal 10 (S10): consumer-driven contract checks between services. A recording proxy sits between a
// consumer (api, bot runner) and a provider (quant, api); every exchange is then validated against
// the provider's own OpenAPI document (FastAPI's for quant, `buildOpenApi` for the api).
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

export interface Exchange {
  consumer: string;
  method: string;
  path: string; // without the query string
  requestBody: unknown;
  status: number;
  responseBody: unknown;
}

function parse(buf: Buffer, type: string | undefined): unknown {
  if (!buf.length) return undefined;
  if (type?.includes('application/json')) {
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      return buf.toString('utf8');
    }
  }
  return undefined; // non-JSON bodies (SSE, text) are not part of these contracts
}

export class RecordingProxy {
  readonly exchanges: Exchange[] = [];
  private server?: Server;
  url = '';

  constructor(
    private readonly target: string,
    private readonly consumer: string,
  ) {}

  async start(): Promise<this> {
    const t = new URL(this.target);
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const up = httpRequest(
          {
            host: t.hostname,
            port: t.port,
            method: req.method,
            path: req.url,
            headers: { ...req.headers, host: t.host },
          },
          (upRes) => {
            const out: Buffer[] = [];
            upRes.on('data', (c: Buffer) => out.push(c));
            upRes.on('end', () => {
              const resBody = Buffer.concat(out);
              this.exchanges.push({
                consumer: this.consumer,
                method: req.method ?? 'GET',
                path: (req.url ?? '/').split('?')[0]!,
                requestBody: parse(body, req.headers['content-type']),
                status: upRes.statusCode ?? 0,
                responseBody: parse(resBody, upRes.headers['content-type']),
              });
              res.writeHead(upRes.statusCode ?? 502, upRes.headers);
              res.end(resBody);
            });
          },
        );
        up.on('error', () => {
          res.writeHead(502);
          res.end();
        });
        up.end(body);
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

type OpenApiDoc = {
  paths: Record<
    string,
    Record<
      string,
      {
        requestBody?: { content?: Record<string, unknown> };
        responses?: Record<string, { content?: Record<string, unknown> }>;
      }
    >
  >;
};

/** Finds the templated OpenAPI path (`/orders/{id}`) that matches a concrete path. */
export function matchPath(doc: OpenApiDoc, path: string): string | null {
  if (doc.paths[path]) return path;
  for (const p of Object.keys(doc.paths)) {
    const re = new RegExp(
      `^${p.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}/g, '[^/]+')}$`,
    );
    if (re.test(path)) return p;
  }
  return null;
}

/**
 * Validates recorded exchanges against a provider's OpenAPI document. Returns human-readable
 * violations (empty = the consumer and the provider agree).
 */
export function validateExchanges(doc: OpenApiDoc, name: string, exchanges: Exchange[]): string[] {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  ajv.addSchema(doc as object, name);
  const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
  const problems: string[] = [];
  for (const x of exchanges) {
    const p = matchPath(doc, x.path);
    const m = x.method.toLowerCase();
    const op = p ? doc.paths[p]?.[m] : undefined;
    if (!p || !op) {
      problems.push(
        `${x.consumer} → ${name}: ${x.method} ${x.path} is not in the provider's OpenAPI`,
      );
      continue;
    }
    const base = `${name}#/paths/${esc(p)}/${m}`;
    if (x.requestBody !== undefined && op.requestBody?.content?.['application/json']) {
      const v = ajv.compile({ $ref: `${base}/requestBody/content/application~1json/schema` });
      if (!v(x.requestBody))
        problems.push(
          `${x.consumer} → ${name}: ${x.method} ${p} request: ${ajv.errorsText(v.errors)}`,
        );
    }
    const res = op.responses?.[String(x.status)];
    if (x.status >= 200 && x.status < 300) {
      if (res?.content?.['application/json'] && x.responseBody !== undefined) {
        const v = ajv.compile({
          $ref: `${base}/responses/${x.status}/content/application~1json/schema`,
        });
        if (!v(x.responseBody))
          problems.push(
            `${x.consumer} ← ${name}: ${x.method} ${p} ${x.status} response: ${ajv.errorsText(v.errors)}`,
          );
      } else if (!res) {
        problems.push(
          `${x.consumer} ← ${name}: ${x.method} ${p} answered ${x.status}, which the provider does not document`,
        );
      }
    }
  }
  return problems;
}
