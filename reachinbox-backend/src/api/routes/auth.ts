import { Router } from "express";
import type { Response } from "express";
import { randomUUID } from "crypto";
import rateLimit from "express-rate-limit";
import { eq, and, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { createToken } from "../middleware/auth.js";
import { authMiddleware } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import { env } from "../../config/env.js";
import { logger } from "../../observability/logger.js";
import { RateLimitError } from "../../domain/errors.js";
import {
  hashPassword,
  verifyPassword,
  fakeVerify,
  passwordPolicyError,
  PASSWORD_MAX_LENGTH,
} from "../../services/auth/passwords.js";

export const authRouter = Router();

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

const SESSION_COOKIE = "session";
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Brute-force budget for the credential endpoints, keyed on the client
 * together with the address being tried so that one attacker cannot lock every
 * user out by exhausting a shared per-IP budget, and cannot spread guesses for
 * one account across source addresses to stay under a per-account cap.
 *
 * Distinct from the general API limiter, which is far looser because it also
 * covers ordinary polling of the dashboard.
 */
const authRateLimiter = rateLimit({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email =
      typeof req.body?.email === "string" ? req.body.email.toLowerCase().trim() : "";
    return `${req.ip}|${email}`;
  },
  handler: (_req, _res, next) => {
    next(
      new RateLimitError(
        "Too many attempts. Please wait a few minutes and try again.",
      ),
    );
  },
});

/**
 * Separate budget for authenticated password changes.
 *
 * Keyed on the account rather than on an address, because unlike register and
 * login this route is not guessing at an identity and has no email in its body.
 * Sharing the ip-keyed bucket would let one user exhaust the allowance and
 * block password changes for every other user behind the same address.
 */
const changePasswordRateLimiter = rateLimit({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? "anonymous",
  handler: (_req, _res, next) => {
    next(
      new RateLimitError(
        "Too many attempts. Please wait a few minutes and try again.",
      ),
    );
  },
});

/**
 * Emails are compared case-insensitively and stored folded.
 *
 * Without this, "User@Example.com" and "user@example.com" would be two
 * different accounts as far as sign-in is concerned, which is a reliable way to
 * lock a user out of the account they just created.
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_MS,
  });
}

function publicUser(user: {
  id: string;
  email: string;
  name: string;
  avatar?: string | null;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatar: user.avatar ?? null,
  };
}

const credentialsSchema = z.object({
  email: z.string().trim().email("Enter a valid email address").max(255),
  password: z
    .string()
    .min(1, "Enter your password")
    .max(PASSWORD_MAX_LENGTH, "Password is too long"),
});

const registerSchema = credentialsSchema.extend({
  // Optional: a credential signup does not need to invent a display name, and
  // the part before "@" is a reasonable default when none is given.
  name: z.string().trim().min(1).max(255).optional(),
});

/* ------------------------------------------------------------------ *
 * Credential sign-up
 * ------------------------------------------------------------------ */

authRouter.post("/register", authRateLimiter, validate(registerSchema), async (req, res, next) => {
  try {
    const { email, password, name } = req.body as z.infer<typeof registerSchema>;

    const policyError = passwordPolicyError(password);
    if (policyError) {
      res.status(400).json({
        error: { code: "WEAK_PASSWORD", message: policyError },
      });
      return;
    }

    const normalized = normalizeEmail(email);

    // Rejected rather than merged: silently attaching a password to whichever
    // account happened to match would let anyone who knows an address claim it
    // by "registering" it. The owner of a Google-only account sets a password
    // from Settings instead, where the session has already proved who they are.
    const existing = await db.query.users.findFirst({
      where: eq(users.email, normalized),
    });
    if (existing) {
      res.status(409).json({
        error: {
          code: "EMAIL_TAKEN",
          message:
            "An account with this email already exists. Sign in with Google, or set a password in Settings.",
        },
      });
      return;
    }

    const displayName = name?.trim() || normalized.split("@")[0] || "User";

    const inserted = await db
      .insert(users)
      .values({
        // provider_subject is NOT NULL and carries the Google subject for
        // linked accounts, so credential accounts get a namespaced synthetic
        // value that can never collide with a real Google subject.
        providerSubject: `local:${randomUUID()}`,
        email: normalized,
        name: displayName,
        passwordHash: await hashPassword(password),
      })
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        avatar: users.avatar,
      });

    const user = inserted[0]!;
    setSessionCookie(res, await createToken(user.id));
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------------ *
 * Credential sign-in
 * ------------------------------------------------------------------ */

authRouter.post("/login", authRateLimiter, validate(credentialsSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body as z.infer<typeof credentialsSchema>;
    const normalized = normalizeEmail(email);

    const candidates = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        avatar: users.avatar,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(and(eq(users.email, normalized), isNotNull(users.passwordHash)))
      .limit(2);

    const user = candidates[0];

    if (!user) {
      // Spend the same CPU a real verification would, so an unregistered
      // address is not distinguishable from a wrong password by response time.
      await fakeVerify();

      // The distinction is worth making: a Google-only account really cannot
      // use this form, and "Incorrect email or password" would read as a bug.
      // This does confirm the address exists to someone who already knows it,
      // which is the accepted trade for a credential form offered alongside
      // Google sign-in. Tighten to one generic message if enumeration matters
      // more than the clearer error.
      const googleOnly = await db.query.users.findFirst({
        where: eq(users.email, normalized),
      });

      res.status(401).json(
        googleOnly
          ? {
              error: {
                code: "PASSWORD_LOGIN_UNAVAILABLE",
                message:
                  "This account signs in with Google. Use “Continue with Google”, or set a password in Settings.",
              },
            }
          : {
              error: {
                code: "INVALID_CREDENTIALS",
                message: "Incorrect email or password",
              },
            },
      );
      return;
    }

    if (!(await verifyPassword(password, user.passwordHash))) {
      res.status(401).json({
        error: {
          code: "INVALID_CREDENTIALS",
          message: "Incorrect email or password",
        },
      });
      return;
    }

    setSessionCookie(res, await createToken(user.id));
    res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------------ *
 * Password management
 * ------------------------------------------------------------------ */

const changePasswordSchema = z
  .object({
    // Required only when the account already has a password. Left optional at
    // the schema level because "no password yet" and "wrong current password"
    // are different situations the handler must distinguish.
    currentPassword: z.string().max(PASSWORD_MAX_LENGTH).optional(),
    newPassword: z
      .string()
      .min(1, "Enter a new password")
      .max(PASSWORD_MAX_LENGTH, "Password is too long"),
  })
  .refine((value) => "newPassword" in value, {
    message: "Provide a new password",
  });

authRouter.post(
  "/change-password",
  authMiddleware,
  changePasswordRateLimiter,
  validate(changePasswordSchema),
  async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.body as z.infer<
        typeof changePasswordSchema
      >;

      const policyError = passwordPolicyError(newPassword);
      if (policyError) {
        res.status(400).json({
          error: { code: "WEAK_PASSWORD", message: policyError },
        });
        return;
      }

      const row = await db.query.users.findFirst({
        where: eq(users.id, req.user!.id),
      });
      if (!row) {
        res.status(401).json({
          error: { code: "SESSION_EXPIRED", message: "Account no longer exists" },
        });
        return;
      }

      if (row.passwordHash) {
        // Changing an existing password requires proving you know the old one,
        // so a stolen session cookie alone cannot lock the real owner out.
        if (!currentPassword) {
          res.status(400).json({
            error: {
              code: "CURRENT_PASSWORD_REQUIRED",
              message: "Enter your current password",
            },
          });
          return;
        }
        if (!(await verifyPassword(currentPassword, row.passwordHash))) {
          res.status(401).json({
            error: {
              code: "INVALID_CREDENTIALS",
              message: "Your current password is incorrect",
            },
          });
          return;
        }
      } else if (currentPassword) {
        // A supplied current password on an account that has none is a client
        // bug, not a wrong guess.
        res.status(400).json({
          error: {
            code: "CURRENT_PASSWORD_UNEXPECTED",
            message: "This account has no password yet",
          },
        });
        return;
      }

      if (row.passwordHash && newPassword === currentPassword) {
        res.status(400).json({
          error: {
            code: "PASSWORD_UNCHANGED",
            message: "Choose a password different from the current one",
          },
        });
        return;
      }

      await db
        .update(users)
        .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
        .where(eq(users.id, req.user!.id));

      res.json({ status: "password_changed" });
    } catch (error) {
      next(error);
    }
  },
);

/* ------------------------------------------------------------------ *
 * Google OAuth
 * ------------------------------------------------------------------ */

function generateOAuthState(): string {
  return randomUUID();
}

authRouter.get("/google", (_req, res) => {
  const state = generateOAuthState();
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_CALLBACK_URL,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });

  res.cookie("oauth_state", state, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
  });

  res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
});

authRouter.get("/google/callback", async (req, res, next) => {
  try {
    const { code, state } = req.query as { code: string; state: string };
    const cookieState = req.cookies?.oauth_state;

    if (!cookieState || cookieState !== state) {
      res.status(400).json({ error: "Invalid OAuth state" });
      return;
    }

    res.clearCookie("oauth_state");

    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: env.GOOGLE_CALLBACK_URL,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed: ${tokenResponse.status}`);
    }

    const tokens = (await tokenResponse.json()) as { access_token: string };

    const userinfoResponse = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userinfoResponse.ok) {
      throw new Error(`Userinfo fetch failed: ${userinfoResponse.status}`);
    }

    const profile = (await userinfoResponse.json()) as {
      sub: string;
      email: string;
      name: string;
      picture?: string;
    };

    const normalizedEmail = normalizeEmail(profile.email);

    const bySubject = await db.query.users.findFirst({
      where: eq(users.providerSubject, profile.sub),
    });

    let userId: string;

    if (bySubject) {
      userId = bySubject.id;
      await db
        .update(users)
        .set({
          email: normalizedEmail,
          name: profile.name,
          avatar: profile.picture ?? null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
    } else {
      // Google has just proved the user owns this address. If an account
      // already holds it, attach the Google identity to that row instead of
      // creating a second one: two rows sharing an email would make credential
      // sign-in ambiguous, and would split the user's schedules across two
      // accounts. A password already on that row is preserved, so the account
      // keeps working with either sign-in method.
      const byEmail = await db.query.users.findFirst({
        where: eq(users.email, normalizedEmail),
      });

      if (byEmail) {
        userId = byEmail.id;
        await db
          .update(users)
          .set({
            providerSubject: profile.sub,
            name: profile.name,
            avatar: profile.picture ?? null,
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId));
      } else {
        const newUser = await db
          .insert(users)
          .values({
            providerSubject: profile.sub,
            email: normalizedEmail,
            name: profile.name,
            avatar: profile.picture ?? null,
          })
          .returning({ id: users.id });
        userId = newUser[0]!.id;
      }
    }

    const token = await createToken(userId);

    setSessionCookie(res, token);

    logger.info({ userId }, "Google OAuth sign-in complete");

    res.redirect(env.FRONTEND_URL || "http://localhost:3001");
  } catch (error) {
    logger.error({ err: error }, "Google OAuth callback failed");
    next(error);
  }
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ status: "logged_out" });
});
