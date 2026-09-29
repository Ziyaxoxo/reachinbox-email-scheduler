import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { apiRateLimiter } from "../middleware/rateLimit.js";
import { createSchedule } from "../../services/scheduler.js";
import { db } from "../../db/client.js";
import { schedules, recipients } from "../../db/schema.js";
import { eq, and, desc, ilike, inArray, sql, type SQL } from "drizzle-orm";
import { NotFoundError, AuthorizationError, ValidationError } from "../../domain/errors.js";

export const schedulesRouter = Router();

schedulesRouter.use(authMiddleware);
schedulesRouter.use(apiRateLimiter);

const MAX_RECIPIENTS = 1000;

const createScheduleSchema = z.object({
  subject: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(100_000),
  recipients: z
    .array(z.string().email().max(320))
    .min(1)
    .max(MAX_RECIPIENTS),
  startAt: z.string().datetime({ offset: true }),
  delayMs: z.number().int().min(0).max(86_400_000).default(0),
  hourlyLimit: z.number().int().min(1).max(10_000).default(100),
  idempotencyKey: z.string().min(8).max(255).optional(),
});

// Bounded page size — unbounded retrieval is impossible.
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z
    .enum(["scheduled", "queued", "sending", "sent", "failed", "cancelled"])
    .optional(),
  search: z.string().trim().min(1).max(255).optional(),
});

schedulesRouter.post(
  "/",
  validate(createScheduleSchema),
  async (req, res, next) => {
    try {
      // Prefer the transport-level header; fall back to the body field so
      // either contract works. Stable across retries of the same logical
      // request, which is what makes replay safe.
      const headerKey = req.headers["idempotency-key"];
      const idempotencyKey =
        (typeof headerKey === "string" ? headerKey : undefined) ??
        req.body.idempotencyKey;

      const result = await createSchedule({
        ownerId: req.user!.id,
        subject: req.body.subject,
        body: req.body.body,
        recipients: req.body.recipients,
        startAt: new Date(req.body.startAt),
        delayMs: req.body.delayMs,
        hourlyLimit: req.body.hourlyLimit,
        idempotencyKey,
        correlationId: req.correlationId,
      });

      // 201 on first creation, 200 when replaying an existing resource.
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      next(error);
    }
  },
);

schedulesRouter.get(
  "/",
  validate(listQuerySchema, "query"),
  async (req, res, next) => {
    try {
      const { page, limit, status, search } = req.query as unknown as z.infer<
        typeof listQuerySchema
      >;

      const offset = (page - 1) * limit;
      const conditions: SQL[] = [eq(schedules.ownerId, req.user!.id)];

      if (status) conditions.push(eq(schedules.status, status));
      if (search) {
        // Parameterized — no string interpolation into SQL.
        conditions.push(ilike(schedules.subject, `%${search}%`));
      }

      const [items, countRows] = await Promise.all([
        db.query.schedules.findMany({
          where: and(...conditions),
          orderBy: [desc(schedules.createdAt)],
          limit,
          offset,
        }),
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(schedules)
          .where(and(...conditions)),
      ]);

      const total = countRows[0]?.total ?? 0;

      // Recipient summary for the page, resolved in one grouped query rather
      // than one per row. The Scheduled view renders a real address, so the
      // list has to carry one; a campaign can have up to 1000 recipients, so it
      // also carries the count for the "+N more" affordance.
      const pageIds = items.map((item) => item.id);
      const summaryRows =
        pageIds.length === 0
          ? []
          : await db
              .select({
                scheduleId: recipients.scheduleId,
                recipientCount: sql<number>`count(*)::int`,
                // sequenceNo defines send order, so the first recipient is the
                // one the user will see arrive first.
                firstRecipientEmail: sql<string | null>`(
                  array_agg(${recipients.normalizedEmail} order by ${recipients.sequenceNo} asc)
                )[1]`,
              })
              .from(recipients)
              .where(inArray(recipients.scheduleId, pageIds))
              .groupBy(recipients.scheduleId);

      const summaryById = new Map(
        summaryRows.map((row) => [row.scheduleId, row]),
      );

      const enriched = items.map((item) => {
        const summary = summaryById.get(item.id);
        return {
          ...item,
          recipientCount: summary?.recipientCount ?? 0,
          firstRecipientEmail: summary?.firstRecipientEmail ?? null,
        };
      });

      res.json({
        items: enriched,
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

schedulesRouter.get("/:id", async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      throw new ValidationError("Malformed schedule id");
    }

    const schedule = await db.query.schedules.findFirst({
      where: eq(schedules.id, req.params.id),
    });

    // 404 before 403 so probing cannot confirm another owner's id exists.
    if (!schedule) throw new NotFoundError("Schedule not found");
    if (schedule.ownerId !== req.user!.id) throw new AuthorizationError();

    const recipientList = await db.query.recipients.findMany({
      where: eq(recipients.scheduleId, schedule.id),
      orderBy: (r, { asc }) => [asc(r.sequenceNo)],
    });

    res.json({ ...schedule, recipients: recipientList });
  } catch (error) {
    next(error);
  }
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
