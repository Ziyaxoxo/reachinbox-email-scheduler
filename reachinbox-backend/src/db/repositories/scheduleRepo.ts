import { db } from "../client.js";
import { schedules } from "../schema.js";
import { eq, and, desc, type SQL } from "drizzle-orm";

export async function findScheduleById(id: string) {
  return db.query.schedules.findFirst({
    where: eq(schedules.id, id),
  });
}

export async function findSchedulesByOwner(
  ownerId: string,
  options: { page: number; limit: number; status?: string; search?: string },
) {
  const { page, limit, status, search } = options;
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [eq(schedules.ownerId, ownerId)];
  if (status) conditions.push(eq(schedules.status, status as never));
  if (search) {
    conditions.push(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (schedules.subject as any).ilike(`%${search}%`),
    );
  }

  return db.query.schedules.findMany({
    where: and(...conditions),
    orderBy: [desc(schedules.createdAt)],
    limit,
    offset,
  });
}

export async function updateScheduleStatus(id: string, status: string) {
  await db
    .update(schedules)
    .set({ status: status as never, updatedAt: new Date() })
    .where(eq(schedules.id, id));
}
