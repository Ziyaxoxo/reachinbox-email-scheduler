import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import { env } from "../../config/env.js";

/**
 * Operator guard for the BullMQ dashboard.
 *
 * The dashboard exposes queue payloads and job history, so it is never public.
 * Bearer/token auth is required and the mutating HTTP methods are refused by
 * default so the safe baseline stays read-only.
 */
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function dashboardAuth(req: Request, res: Response, next: NextFunction) {
  // Fail closed: no configured token means no dashboard access at all.
  if (!env.DASHBOARD_TOKEN) {
    res.status(503).send("Dashboard disabled: operator token not configured");
    return;
  }

  const header = req.headers.authorization;
  const presented =
    header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const provided = req.query.token;

  const authorized =
    (presented !== undefined && safeEqual(presented, env.DASHBOARD_TOKEN)) ||
    (typeof provided === "string" && safeEqual(provided, env.DASHBOARD_TOKEN));

  if (!authorized) {
    res
      .status(401)
      .set("WWW-Authenticate", 'Bearer realm="reachinbox-queues"')
      .send("Unauthorized");
    return;
  }

  if (env.DASHBOARD_READ_ONLY && !READ_ONLY_METHODS.has(req.method)) {
    res.status(403).send("Dashboard is read-only");
    return;
  }

  next();
}
