import { Router } from "express";
import { randomUUID } from "crypto";
import { createToken } from "../middleware/auth.js";
import { db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { env } from "../../config/env.js";
import { logger } from "../../observability/logger.js";

export const authRouter = Router();

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

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

    const existingUser = await db.query.users.findFirst({
      where: eq(users.providerSubject, profile.sub),
    });

    let userId: string;

    if (existingUser) {
      userId = existingUser.id;
      await db
        .update(users)
        .set({
          email: profile.email,
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
          email: profile.email,
          name: profile.name,
          avatar: profile.picture ?? null,
        })
        .returning({ id: users.id });
      userId = newUser[0]!.id;
    }

    const token = await createToken(userId);

    res.cookie("session", token, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.redirect(env.FRONTEND_URL || "http://localhost:3001");
  } catch (error) {
    logger.error({ err: error }, "Google OAuth callback failed");
    next(error);
  }
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie("session");
  res.json({ status: "logged_out" });
});
