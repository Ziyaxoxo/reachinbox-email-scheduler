import type { Request, Response, NextFunction } from "express";
import { jwtVerify, SignJWT } from "jose";
import { env } from "../../config/env.js";
import { AuthenticationError, AuthorizationError } from "../../domain/errors.js";
import { db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import { eq } from "drizzle-orm";

const jwtSecret = new TextEncoder().encode(env.JWT_SECRET);

export async function createToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(jwtSecret);
}

export async function verifyToken(token: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, jwtSecret);
    return payload.sub as string;
  } catch {
    throw new AuthenticationError("Invalid or expired token");
  }
}

export async function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : req.cookies?.session;

    if (!token) {
      throw new AuthenticationError();
    }

    const userId = await verifyToken(token);

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, email: true, name: true, avatar: true },
    });

    if (!user) {
      throw new AuthenticationError("User not found");
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireOwnership(paramName = "id") {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AuthenticationError());
    }

    const resourceId = req.params[paramName];
    if (!resourceId) {
      return next(new AuthorizationError("Resource ID required"));
    }

    next();
  };
}
