import { randomUUID } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { createChildLogger } from "./logger.js";

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const correlationId = (req.headers["x-correlation-id"] as string) || randomUUID();
  req.correlationId = correlationId;
  res.setHeader("x-correlation-id", correlationId);

  const childLogger = createChildLogger({ correlationId });
  req.logger = childLogger;

  next();
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId: string;
      logger: ReturnType<typeof createChildLogger>;
      user?: {
        id: string;
        email: string;
        name: string;
      };
    }
  }
}
