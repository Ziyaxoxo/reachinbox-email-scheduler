import rateLimit from "express-rate-limit";
import { env } from "../../config/env.js";
import { RateLimitError } from "../../domain/errors.js";

export const apiRateLimiter = rateLimit({
  windowMs: env.API_RATE_LIMIT_WINDOW_MS,
  max: env.API_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip || "anonymous",
  handler: (_req, _res, next) => {
    next(new RateLimitError("API rate limit exceeded. Please try again later."));
  },
});
