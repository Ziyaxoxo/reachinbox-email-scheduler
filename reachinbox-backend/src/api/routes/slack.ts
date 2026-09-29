import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { apiRateLimiter } from "../middleware/rateLimit.js";
import { initiateSlackOAuth, handleSlackCallback, getSlackStatus, disconnectSlack } from "../../services/slack/oauth.js";
import { env } from "../../config/env.js";

export const slackRouter = Router();

slackRouter.post("/connect", authMiddleware, apiRateLimiter, async (req, res, next) => {
  try {
    const { url, state } = await initiateSlackOAuth(req.user!.id);
    res.json({ url, state });
  } catch (error) {
    next(error);
  }
});

// Slack redirects here from the browser, so this route must not require a session.
// Authorization is proven by the single-use state value instead.
slackRouter.get("/callback", async (req, res, next) => {
  try {
    const { code, state, error: slackError } = req.query as {
      code?: string;
      state?: string;
      error?: string;
    };

    if (slackError) {
      res.redirect(`${env.FRONTEND_URL}/login?slack=denied`);
      return;
    }

    if (!code || !state) {
      res.redirect(`${env.FRONTEND_URL}/login?slack=invalid_callback`);
      return;
    }

    await handleSlackCallback(code, state);
    res.redirect(env.FRONTEND_URL);
  } catch (error) {
    next(error);
  }
});

slackRouter.use(authMiddleware);
slackRouter.use(apiRateLimiter);

slackRouter.get("/status", async (req, res, next) => {
  try {
    const status = await getSlackStatus(req.user!.id);
    res.json(status);
  } catch (error) {
    next(error);
  }
});

slackRouter.delete("/connection", async (req, res, next) => {
  try {
    await disconnectSlack(req.user!.id);
    res.json({ status: "disconnected" });
  } catch (error) {
    next(error);
  }
});
