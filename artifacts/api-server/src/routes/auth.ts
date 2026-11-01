import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { Router, type IRouter, type Response } from "express";
import {
  CreateAccountBody,
  DeleteAccountParams,
  LoginBody,
  SetupAdminBody,
  UpdateAccountBody,
  UpdateAccountParams,
} from "@workspace/api-zod";
import { db, sessionsTable, usersTable } from "@workspace/db";
import { requireAdmin, requireUser, SESSION_COOKIE } from "../middlewares/auth";

const router: IRouter = Router();
const sessionDurationMs = 7 * 24 * 60 * 60 * 1000;
const attempts = new Map<string, { count: number; startedAt: number }>();
const lockWindowMs = 15 * 60 * 1000;
const maxAttempts = 8;
const dummySalt = "safe-dummy-salt-for-login-check";
const dummyHash = "a".repeat(128);
const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.FRONTEND_ORIGIN ? ("none" as const) : ("lax" as const),
  path: "/",
};

async function hashPasscode(passcode: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scryptCallback(passcode, salt, 64, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey.toString("hex"));
    });
  });
}

async function verifyPasscode(passcode: string, salt: string, expected: string): Promise<boolean> {
  const actual = Buffer.from(await hashPasscode(passcode, salt), "hex");
  const target = Buffer.from(expected, "hex");
  return actual.length === target.length && timingSafeEqual(actual, target);
}

async function startSession(userId: string, res: Response): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + sessionDurationMs);
  await db.insert(sessionsTable).values({ tokenHash, userId, expiresAt });
  res.cookie(SESSION_COOKIE, token, {
    ...sessionCookieOptions,
    maxAge: sessionDurationMs,
  });
}

function publicUser(user: {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "organizer";
}) {
  return { id: user.id, username: user.username, displayName: user.displayName, role: user.role };
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

router.get("/auth/bootstrap", async (_req, res): Promise<void> => {
  const existing = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
  res.json({ setupRequired: existing.length === 0 });
});

router.post("/auth/setup", async (req, res): Promise<void> => {
  const parsed = SetupAdminBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { username, displayName, passcode } = parsed.data;
  const salt = randomBytes(24).toString("hex");
  const passcodeHash = await hashPasscode(passcode, salt);
  try {
    const [admin] = await db
      .insert(usersTable)
      .values({
        username: normalizeUsername(username),
        displayName: displayName.trim(),
        passcodeHash,
        passcodeSalt: salt,
        role: "admin",
      })
      .returning();
    if (!admin) {
      res.status(409).json({ error: "La configuration initiale est déjà terminée" });
      return;
    }
    await startSession(admin.id, res);
    res.status(201).json(publicUser(admin));
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Un administrateur a déjà été créé" });
      return;
    }
    throw error;
  }
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const username = normalizeUsername(parsed.data.username);
  const key = `${req.ip ?? "unknown"}:${username}`;
  const now = Date.now();
  const current = attempts.get(key);
  if (current && now - current.startedAt < lockWindowMs && current.count >= maxAttempts) {
    res.status(429).json({ error: "Trop de tentatives. Réessayez dans quelques minutes." });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.username, username)).limit(1);
  const valid = user?.active
    ? await verifyPasscode(parsed.data.passcode, user.passcodeSalt, user.passcodeHash)
    : await verifyPasscode(parsed.data.passcode, dummySalt, dummyHash);

  if (!user || !user.active || !valid) {
    if (!current || now - current.startedAt >= lockWindowMs) {
      attempts.set(key, { count: 1, startedAt: now });
    } else {
      attempts.set(key, { count: current.count + 1, startedAt: current.startedAt });
    }
    res.status(401).json({ error: "Nom d'utilisateur ou code incorrect" });
    return;
  }

  attempts.delete(key);
  await startSession(user.id, res);
  res.json(publicUser(user));
});

router.get("/auth/me", requireUser, (req, res): void => {
  res.json(publicUser(req.user!));
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === "string") {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await db.delete(sessionsTable).where(eq(sessionsTable.tokenHash, tokenHash));
  }
  res.clearCookie(SESSION_COOKIE, {
    ...sessionCookieOptions,
  });
  res.json({ status: "ok" });
});

router.get("/accounts", requireAdmin, async (_req, res): Promise<void> => {
  const accounts = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      displayName: usersTable.displayName,
      role: usersTable.role,
      active: usersTable.active,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .orderBy(usersTable.createdAt);
  res.json(accounts);
});

router.post("/accounts", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const salt = randomBytes(24).toString("hex");
  try {
    const [account] = await db
      .insert(usersTable)
      .values({
        username: normalizeUsername(parsed.data.username),
        displayName: parsed.data.displayName.trim(),
        passcodeHash: await hashPasscode(parsed.data.passcode, salt),
        passcodeSalt: salt,
        role: "organizer",
      })
      .returning({
        id: usersTable.id,
        username: usersTable.username,
        displayName: usersTable.displayName,
        role: usersTable.role,
        active: usersTable.active,
        createdAt: usersTable.createdAt,
      });
    res.status(201).json(account);
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Ce nom d'utilisateur existe déjà" });
      return;
    }
    throw error;
  }
});

router.patch("/accounts/:accountId", requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateAccountParams.safeParse(req.params);
  const body = UpdateAccountBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (params.data.accountId === req.user!.id && body.data.active === false) {
    res.status(400).json({ error: "Vous ne pouvez pas désactiver votre propre compte" });
    return;
  }

  const update: Partial<typeof usersTable.$inferInsert> = {};
  if (body.data.displayName !== undefined) update.displayName = body.data.displayName.trim();
  if (body.data.active !== undefined) update.active = body.data.active;
  if (body.data.passcode) {
    const salt = randomBytes(24).toString("hex");
    update.passcodeSalt = salt;
    update.passcodeHash = await hashPasscode(body.data.passcode, salt);
  }
  const [account] = await db
    .update(usersTable)
    .set(update)
    .where(eq(usersTable.id, params.data.accountId))
    .returning({
      id: usersTable.id,
      username: usersTable.username,
      displayName: usersTable.displayName,
      role: usersTable.role,
      active: usersTable.active,
      createdAt: usersTable.createdAt,
    });
  if (!account) {
    res.status(404).json({ error: "Compte introuvable" });
    return;
  }
  if (body.data.active === false || body.data.passcode) {
    await db.delete(sessionsTable).where(eq(sessionsTable.userId, account.id));
  }
  res.json(account);
});

router.delete("/accounts/:accountId", requireAdmin, async (req, res): Promise<void> => {
  const params = DeleteAccountParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (params.data.accountId === req.user!.id) {
    res.status(400).json({ error: "Vous ne pouvez pas supprimer votre propre compte" });
    return;
  }
  const [account] = await db
    .delete(usersTable)
    .where(eq(usersTable.id, params.data.accountId))
    .returning({ id: usersTable.id, role: usersTable.role });
  if (!account) {
    res.status(404).json({ error: "Compte introuvable" });
    return;
  }
  res.sendStatus(204);
});

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export default router;
