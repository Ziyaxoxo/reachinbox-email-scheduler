import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { db } from "../../db/client.js";
import { users } from "../../db/schema.js";

export const meRouter = Router();

meRouter.use(authMiddleware);

/**
 * Profile photo is stored inline in the users row as a data URL.
 *
 * Bounded rather than unlimited because it is returned on every /me call, so an
 * unbounded blob would bloat every session read. ~500k chars is roughly a
 * 350 KB image, generous for an avatar.
 */
const MAX_AVATAR_CHARS = 500_000;

const AVATAR_RE = /^(data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/\S+)$/i;

const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    avatar: z.string().max(MAX_AVATAR_CHARS).nullable().optional(),
  })
  .refine((value) => "name" in value || "avatar" in value, {
    message: "Provide name, avatar, or both",
  });

function serialize(user: {
  id: string;
  email: string;
  name: string;
  avatar?: string | null;
  passwordHash?: string | null;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    // Previously omitted, so the client could never render a stored photo.
    avatar: user.avatar ?? null,
    // Whether a password is set, never the hash itself: the client needs this
    // to know whether changing a password must ask for the current one, and a
    // presence flag is all that requires.
    hasPassword: Boolean(user.passwordHash),
  };
}

meRouter.get("/", async (_req, res, next) => {
  try {
    const row = await db.query.users.findFirst({
      where: eq(users.id, _req.user!.id),
    });
    if (!row) {
      res.status(401).json({
        error: { code: "SESSION_EXPIRED", message: "Account no longer exists" },
      });
      return;
    }
    res.json(serialize(row));
  } catch (error) {
    next(error);
  }
});

/**
 * Profile update.
 *
 * Scoped to the authenticated owner by construction: the WHERE clause is the
 * session's own user id, so there is no id a caller could supply to reach
 * another account.
 */
meRouter.patch("/", validate(updateProfileSchema), async (req, res, next) => {
  try {
    const { name, avatar } = req.body as z.infer<typeof updateProfileSchema>;

    if (avatar !== undefined && avatar !== null && !AVATAR_RE.test(avatar)) {
      res.status(400).json({
        error: {
          code: "INVALID_AVATAR",
          message: "Avatar must be an https URL or an image data URL",
        },
      });
      return;
    }

    const patch: { name?: string; avatar?: string | null; updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (name !== undefined) patch.name = name;
    if (avatar !== undefined) patch.avatar = avatar;

    const updated = await db
      .update(users)
      .set(patch)
      .where(eq(users.id, req.user!.id))
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        avatar: users.avatar,
        passwordHash: users.passwordHash,
      });

    const row = updated[0];
    if (!row) {
      res.status(401).json({
        error: { code: "SESSION_EXPIRED", message: "Account no longer exists" },
      });
      return;
    }

    res.json(serialize(row));
  } catch (error) {
    next(error);
  }
});
