import type { Request, Response, NextFunction } from "express";
import { metrics } from "../../observability/metrics.js";

/**
 * Record request count and duration using the matched route pattern, so labels
 * stay bounded (no raw user ids or unbounded paths) and cardinality cannot grow
 * with traffic.
 */
export function requestMetrics(req: Request, res: Response, next: NextFunction) {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    // req.route is undefined on 404s, so fall back to a static bucket.
    const route = req.route?.path
      ? `${req.baseUrl}${req.route.path}`
      : "unmatched";

    metrics.apiRequests.inc({
      method: req.method,
      route,
      status: String(res.statusCode),
    });

    metrics.apiRequestDuration.observe(
      { method: req.method, route, status: String(res.statusCode) },
      seconds,
    );
  });

  next();
}
