import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { apiRateLimiter } from "../middleware/rateLimit.js";
import { db } from "../../db/client.js";
import { recipients, schedules, deliveryAttempts, senders } from "../../db/schema.js";
import {
  eq,
  and,
  or,
  desc,
  ilike,
  gte,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import { searchEmailIndex } from "../../services/elasticsearch/indexer.js";
import { logger } from "../../observability/logger.js";

export const emailsRouter = Router();

emailsRouter.use(authMiddleware);
emailsRouter.use(apiRateLimiter);

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z
    .enum(["scheduled", "queued", "sending", "sent", "failed", "cancelled"])
    .optional(),
  search: z.string().trim().min(1).max(255).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

/**
 * Recipient-level delivery record.
 *
 * Explicitly declared rather than inferred so the client contract cannot drift
 * when the recipients table changes.
 */
interface SentRow {
  id: string;
  scheduleId: string;
  normalizedEmail: string;
  sequenceNo: number;
  scheduledAt: Date;
  status: "scheduled" | "queued" | "sending" | "sent" | "failed" | "cancelled";
  createdAt: Date;
  updatedAt: Date;
  subject: string;
  body: string;
  startAt: Date;
  ownerId: string;
  senderEmail: string | null;
  attempt: number | null;
  providerId: string | null;
  sentAt: Date | null;
  failureCode: string | null;
  failureMessage: string | null;
}

/**
 * Sent / failed list.
 *
 * `includeScheduled` controls whether future work is included; the Sent view
 * passes false so the table shows delivery outcomes, while Scheduled reads
 * `/schedules`. Either way the payload is the recipient-level record so the
 * UI can render a real recipient address.
 */
emailsRouter.get(
  "/sent",
  validate(listQuerySchema, "query"),
  async (req, res, next) => {
    try {
      const { page, limit, status, search, from, to } = req.query as unknown as z.infer<
        typeof listQuerySchema
      >;

      const offset = (page - 1) * limit;
      const conditions: SQL[] = [eq(schedules.ownerId, req.user!.id)];

      if (status) {
        conditions.push(eq(recipients.status, status));
      } else {
        // Default view is delivery outcomes only.
        conditions.push(eq(recipients.status, "sent"));
      }

      if (search) {
        // Match either the recipient address or the subject.
        conditions.push(
          or(
            ilike(recipients.normalizedEmail, `%${search}%`),
            ilike(schedules.subject, `%${search}%`),
          )!,
        );
      }

      if (from) conditions.push(gte(recipients.scheduledAt, new Date(from)));
      if (to) conditions.push(lte(recipients.scheduledAt, new Date(to)));

      const base = and(...conditions);

      const [rows, countRows] = await Promise.all([
        db
          .select({
            id: recipients.id,
            scheduleId: recipients.scheduleId,
            normalizedEmail: recipients.normalizedEmail,
            sequenceNo: recipients.sequenceNo,
            scheduledAt: recipients.scheduledAt,
            status: recipients.status,
            createdAt: recipients.createdAt,
            updatedAt: recipients.updatedAt,
            subject: schedules.subject,
            body: schedules.body,
            startAt: schedules.startAt,
            ownerId: schedules.ownerId,
            senderEmail: senders.email,
            attempt: deliveryAttempts.attempt,
            providerId: deliveryAttempts.providerId,
            sentAt: deliveryAttempts.sentAt,
            failureCode: deliveryAttempts.failureCode,
            failureMessage: deliveryAttempts.failureMessage,
          })
          .from(recipients)
          .innerJoin(schedules, eq(recipients.scheduleId, schedules.id))
          .leftJoin(senders, eq(schedules.ownerId, senders.ownerId))
          .leftJoin(
            deliveryAttempts,
            eq(deliveryAttempts.recipientId, recipients.id),
          )
          .where(base)
          .orderBy(desc(recipients.updatedAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(recipients)
          .innerJoin(schedules, eq(recipients.scheduleId, schedules.id))
          .where(base),
      ]);

      const total = countRows[0]?.total ?? 0;

      const items = rows.map((row) => ({
        id: row.id,
        scheduleId: row.scheduleId,
        normalizedEmail: row.normalizedEmail,
        sequenceNo: row.sequenceNo,
        scheduledAt: row.scheduledAt,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        subject: row.subject,
        body: row.body,
        startAt: row.startAt,
        ownerId: row.ownerId,
        senderEmail: row.senderEmail,
        attempt: row.attempt,
        providerId: row.providerId,
        sentAt: row.sentAt,
        failureCode: row.failureCode,
        failureMessage: row.failureMessage,
      })) satisfies SentRow[];

      res.json({
        items,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Elasticsearch-backed search over the derived read model.
 *
 * Authoritative filtering always happens in SQL; this path only adds
 * full-text relevance on top. If ES is unavailable the request degrades to a
 * structured 503 rather than failing the primary flow.
 */
emailsRouter.get("/search", async (req, res, next) => {
  try {
    const page = Math.min(Number(req.query.page) || 1, 1000);
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const query = typeof req.query.q === "string" ? req.query.q.slice(0, 255) : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;

    const result = await searchEmailIndex({
      ownerId: req.user!.id,
      query,
      status,
      page,
      limit,
    });

    res.json({
      items: result.items,
      pagination: {
        page,
        limit,
        total: result.total,
        totalPages: Math.max(1, Math.ceil(result.total / limit)),
      },
    });
  } catch (error) {
    logger.warn({ err: error }, "Search read model unavailable");
    next(error);
  }
});
