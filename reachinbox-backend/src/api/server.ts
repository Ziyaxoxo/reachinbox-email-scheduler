import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import { ExpressAdapter } from "@bull-board/express";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { createBullBoard } from "@bull-board/api";
import { emailQueue } from "../queue/connection.js";
import { outboxQueue } from "../queue/connection.js";
import { correlationIdMiddleware } from "../observability/tracing.js";
import { requestMetrics } from "./middleware/requestMetrics.js";
import { dashboardAuth } from "./middleware/dashboardAuth.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { healthRouter } from "./routes/health.js";
import { meRouter } from "./routes/me.js";
import { schedulesRouter } from "./routes/schedules.js";
import { emailsRouter } from "./routes/emails.js";
import { slackRouter } from "./routes/slack.js";
import { authRouter } from "./routes/auth.js";
import { env } from "../config/env.js";

export function createServer() {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.NODE_ENV === "production" ? false : true,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "10mb" }));
  app.use(cookieParser());
  app.use(correlationIdMiddleware);
  app.use(requestMetrics);

  // BullBoard dashboard — operator-only, read-only by default.
  const serverAdapter = new ExpressAdapter();
  createBullBoard({
    queues: [new BullMQAdapter(emailQueue), new BullMQAdapter(outboxQueue)],
    serverAdapter,
  });
  app.use("/admin/queues", dashboardAuth, serverAdapter.getRouter());

  // Routes
  app.use("/health", healthRouter);
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/me", meRouter);
  app.use("/api/v1/schedules", schedulesRouter);
  app.use("/api/v1/emails", emailsRouter);
  app.use("/api/v1/slack", slackRouter);

  // Metrics endpoint
  app.get("/metrics", async (_req, res) => {
    const { register } = await import("../observability/metrics.js");
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  });

  // Error handler
  app.use(errorHandler);

  return app;
}
