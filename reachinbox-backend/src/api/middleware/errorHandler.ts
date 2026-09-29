import type { Request, Response, NextFunction } from "express";
import { AppError } from "../../domain/errors.js";
import { metrics } from "../../observability/metrics.js";

/**
 * Errors raised by upstream middleware (body-parser, cookie-parser, urlencoded)
 * carry their own `status`. Without honouring it, an oversized payload is
 * reported as a 500, which blames the server for a client mistake, pollutes
 * error-rate alerting, and tells the caller the wrong thing.
 */
function upstreamStatus(error: Error & { status?: number; statusCode?: number }): number | null {
  const status = error.status ?? error.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return status;
  }
  return null;
}

const UPSTREAM_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "AUTHENTICATION_ERROR",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  429: "RATE_LIMIT_EXCEEDED",
};

export function errorHandler(
  error: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : "unmatched";

  if (error instanceof AppError) {
    metrics.apiRequests.inc({ method: req.method, route, status: String(error.statusCode) });

    req.logger?.warn(
      { err: error, statusCode: error.statusCode, code: error.code },
      "Request failed with application error",
    );

    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
        correlationId: req.correlationId,
      },
    });
    return;
  }

  const upstream = upstreamStatus(error);
  if (upstream) {
    metrics.apiRequests.inc({ method: req.method, route, status: String(upstream) });

    req.logger?.warn(
      { err: error, statusCode: upstream },
      "Request rejected by middleware",
    );

    res.status(upstream).json({
      error: {
        code: UPSTREAM_CODES[upstream] ?? "BAD_REQUEST",
        message: error.message,
        correlationId: req.correlationId,
      },
    });
    return;
  }

  metrics.apiRequests.inc({ method: req.method, route, status: "500" });

  req.logger?.error({ err: error }, "Unhandled error");

  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
      correlationId: req.correlationId,
    },
  });
}
