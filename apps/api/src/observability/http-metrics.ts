import type { NextFunction, Request, Response } from 'express';

import type { OpsMetrics } from './ops-metrics.service';

/**
 * Express middleware (goal 10): request count and latency per route template (never the raw URL,
 * to keep label cardinality bounded) and status class. Feeds SLO-1 availability / error budget and
 * the latency panels. /metrics and /health are not counted.
 */
export function httpMetrics(metrics: OpsMetrics) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === '/metrics' || req.path === '/health') return next();
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      const routePath = (req.route as { path?: string } | undefined)?.path;
      const route = routePath ? `${req.baseUrl}${routePath}` : 'unmatched';
      const status = `${Math.floor(res.statusCode / 100)}xx`;
      metrics.http.inc({ method: req.method, route, status });
      metrics.httpDuration.observe({ method: req.method, route }, Number(process.hrtime.bigint() - t0) / 1e9);
    });
    next();
  };
}
