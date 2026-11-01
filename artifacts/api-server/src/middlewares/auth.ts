import { createHash } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { RequestHandler } from "express";
import { db, eventsTable, sessionsTable, usersTable } from "@workspace/db";

export type SessionUser = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "organizer";
};

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export const SESSION_COOKIE = "invite_manager_session";

export const loadSession: RequestHandler = async (req, _res, next): Promise<void> => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token || typeof token !== "string") {
    next();
    return;
  }

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const [session] = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      displayName: usersTable.displayName,
      role: usersTable.role,
    })
    .from(sessionsTable)
    .innerJoin(usersTable, eq(sessionsTable.userId, usersTable.id))
    .where(
      and(
        eq(sessionsTable.tokenHash, tokenHash),
        gt(sessionsTable.expiresAt, new Date()),
        eq(usersTable.active, true),
      ),
    )
    .limit(1);

  if (session) {
    req.user = session;
  }
  next();
};

export const requireUser: RequestHandler = (req, res, next): void => {
  if (!req.user) {
    res.status(401).json({ error: "Connexion requise" });
    return;
  }
  next();
};

export const requireAdmin: RequestHandler = (req, res, next): void => {
  if (!req.user) {
    res.status(401).json({ error: "Connexion requise" });
    return;
  }
  if (req.user.role !== "admin") {
    res.status(403).json({ error: "Accès réservé à l'administrateur" });
    return;
  }
  next();
};

/**
 * Administrators can manage every event. Organizers can only access events
 * they created. Keeping this check in one place prevents resource routes from
 * accidentally exposing another organizer's guest data.
 */
export async function canAccessEvent(user: SessionUser, eventId: string): Promise<boolean> {
  if (user.role === "admin") return true;
  const [event] = await db
    .select({ id: eventsTable.id })
    .from(eventsTable)
    .where(and(eq(eventsTable.id, eventId), eq(eventsTable.createdBy, user.id)))
    .limit(1);
  return Boolean(event);
}
