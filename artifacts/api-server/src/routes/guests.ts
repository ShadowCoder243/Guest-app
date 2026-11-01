import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { Router, type IRouter, type RequestHandler } from "express";
import {
  CheckInGuestBody,
  CheckInGuestParams,
  CreateGuestBody,
  CreateGuestParams,
  CreateTableBody,
  CreateTableParams,
  DeleteGuestParams,
  DeleteTableParams,
  ExportGuestsParams,
  GetPublicInvitationParams,
  GetTablesParams,
  ListEventGuestsParams,
  MarkGuestSharedParams,
  RespondToInvitationBody,
  RespondToInvitationParams,
  SyncOfflineCheckInsBody,
  SyncOfflineCheckInsParams,
  UpdateGuestBody,
  UpdateGuestParams,
  UpdateTableBody,
  UpdateTableParams,
} from "@workspace/api-zod";
import { db, eventsTable, guestTablesTable, guestsTable, offlineCheckInsTable } from "@workspace/db";
import { canAccessEvent, requireUser } from "../middlewares/auth";

const router: IRouter = Router();
const baseInvitePath = "/invite/";

const requireAccessibleEvent: RequestHandler = async (req, res, next): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ error: "Connexion requise" });
    return;
  }
  const eventId = req.params.eventId;
  if (typeof eventId !== "string" || !(await canAccessEvent(req.user, eventId))) {
    res.status(404).json({ error: "Événement introuvable" });
    return;
  }
  next();
};

const requireAccessibleTable: RequestHandler = async (req, res, next): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ error: "Connexion requise" });
    return;
  }
  const tableId = typeof req.params.tableId === "string" ? req.params.tableId : null;
  const [table] = tableId
    ? await db
        .select({ eventId: guestTablesTable.eventId })
        .from(guestTablesTable)
        .where(eq(guestTablesTable.id, tableId))
        .limit(1)
    : [];
  if (!table || !(await canAccessEvent(req.user, table.eventId))) {
    res.status(404).json({ error: "Table introuvable" });
    return;
  }
  next();
};

const requireAccessibleGuest: RequestHandler = async (req, res, next): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ error: "Connexion requise" });
    return;
  }
  const guestId = typeof req.params.guestId === "string" ? req.params.guestId : null;
  const [guest] = guestId
    ? await db
        .select({ eventId: guestsTable.eventId })
        .from(guestsTable)
        .where(eq(guestsTable.id, guestId))
        .limit(1)
    : [];
  if (!guest || !(await canAccessEvent(req.user, guest.eventId))) {
    res.status(404).json({ error: "Invité introuvable" });
    return;
  }
  next();
};

router.use("/events/:eventId", requireAccessibleEvent);
router.use("/tables/:tableId", requireAccessibleTable);
router.use("/guests/:guestId", requireAccessibleGuest);

function invitePath(code: string): string {
  return `${baseInvitePath}${code}`;
}

function groupSizeIsValid(groupType: string, partySize: number): boolean {
  if (groupType === "single") return partySize === 1;
  if (groupType === "couple") return partySize === 2;
  if (groupType === "family") return partySize >= 2;
  return partySize >= 1;
}

class CapacityError extends Error {}

async function findEvent(eventId: string) {
  const [event] = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId)).limit(1);
  return event;
}

async function buildGuest(eventId: string, guestId: string) {
  const [row] = await db
    .select({
      id: guestsTable.id,
      eventId: guestsTable.eventId,
      fullName: guestsTable.fullName,
      groupType: guestsTable.groupType,
      partySize: guestsTable.partySize,
      category: guestsTable.category,
      tableId: guestsTable.tableId,
      tableName: guestTablesTable.name,
      invitationCode: guestsTable.invitationCode,
      invitationStatus: guestsTable.invitationStatus,
      sharedAt: guestsTable.sharedAt,
      rsvpStatus: guestsTable.rsvpStatus,
      checkedInAt: guestsTable.checkedInAt,
      createdAt: guestsTable.createdAt,
    })
    .from(guestsTable)
    .leftJoin(guestTablesTable, eq(guestsTable.tableId, guestTablesTable.id))
    .where(and(eq(guestsTable.eventId, eventId), eq(guestsTable.id, guestId)))
    .limit(1);
  if (!row) return null;
  return { ...row, invitationUrl: invitePath(row.invitationCode) };
}

async function tableAvailable(
  database: any,
  eventId: string,
  tableId: string | null,
  partySize: number,
  excludingGuestId?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!tableId) return { ok: true };
  await database.execute(
    sql`select id from guest_tables where id = ${tableId} and event_id = ${eventId} for update`,
  );
  const [table] = await database
    .select()
    .from(guestTablesTable)
    .where(and(eq(guestTablesTable.id, tableId), eq(guestTablesTable.eventId, eventId)))
    .limit(1);
  if (!table) return { ok: false, error: "Cette table n'appartient pas à cet événement" };

  const conditions = [eq(guestsTable.tableId, tableId), eq(guestsTable.eventId, eventId)];
  if (excludingGuestId) conditions.push(ne(guestsTable.id, excludingGuestId));
  const [usage] = await database
    .select({ seats: sql<number>`coalesce(sum(${guestsTable.partySize}), 0)::int` })
    .from(guestsTable)
    .where(and(...conditions));
  if ((usage?.seats ?? 0) + partySize > table.capacity) {
    return { ok: false, error: `Cette table ne dispose que de ${table.capacity - (usage?.seats ?? 0)} place(s) libre(s)` };
  }
  return { ok: true };
}

router.get("/events/:eventId/tables", requireUser, async (req, res): Promise<void> => {
  const params = GetTablesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select({
      id: guestTablesTable.id,
      eventId: guestTablesTable.eventId,
      name: guestTablesTable.name,
      capacity: guestTablesTable.capacity,
      createdAt: guestTablesTable.createdAt,
      occupiedSeats: sql<number>`coalesce(sum(${guestsTable.partySize}), 0)::int`,
    })
    .from(guestTablesTable)
    .leftJoin(guestsTable, eq(guestsTable.tableId, guestTablesTable.id))
    .where(eq(guestTablesTable.eventId, params.data.eventId))
    .groupBy(guestTablesTable.id)
    .orderBy(asc(guestTablesTable.name));
  res.json(rows);
});

router.post("/events/:eventId/tables", requireUser, async (req, res): Promise<void> => {
  const params = CreateTableParams.safeParse(req.params);
  const body = CreateTableBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const event = await findEvent(params.data.eventId);
  if (!event) {
    res.status(404).json({ error: "Événement introuvable" });
    return;
  }
  if (event.roomCapacity !== null) {
    const [current] = await db
      .select({ seats: sql<number>`coalesce(sum(${guestTablesTable.capacity}), 0)::int` })
      .from(guestTablesTable)
      .where(eq(guestTablesTable.eventId, event.id));
    if ((current?.seats ?? 0) + body.data.capacity > event.roomCapacity) {
      res.status(409).json({ error: "La capacité totale des tables dépasserait celle de la salle" });
      return;
    }
  }
  try {
    const [table] = await db
      .insert(guestTablesTable)
      .values({ eventId: event.id, ...body.data })
      .returning();
    res.status(201).json({ ...table, occupiedSeats: 0 });
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Une table porte déjà ce nom dans cet événement" });
      return;
    }
    throw error;
  }
});

router.patch("/tables/:tableId", requireUser, async (req, res): Promise<void> => {
  const params = UpdateTableParams.safeParse(req.params);
  const body = UpdateTableBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [table] = await db.select().from(guestTablesTable).where(eq(guestTablesTable.id, params.data.tableId));
  if (!table) {
    res.status(404).json({ error: "Table introuvable" });
    return;
  }
  if (body.data.capacity !== undefined) {
    const [usage] = await db
      .select({ seats: sql<number>`coalesce(sum(${guestsTable.partySize}), 0)::int` })
      .from(guestsTable)
      .where(eq(guestsTable.tableId, table.id));
    if (body.data.capacity < (usage?.seats ?? 0)) {
      res.status(409).json({ error: `Cette table accueille déjà ${usage?.seats ?? 0} personne(s)` });
      return;
    }
    const event = await findEvent(table.eventId);
    if (event?.roomCapacity !== null && event?.roomCapacity !== undefined) {
      const [otherCapacity] = await db
        .select({ seats: sql<number>`coalesce(sum(${guestTablesTable.capacity}), 0)::int` })
        .from(guestTablesTable)
        .where(and(eq(guestTablesTable.eventId, table.eventId), ne(guestTablesTable.id, table.id)));
      if ((otherCapacity?.seats ?? 0) + body.data.capacity > event.roomCapacity) {
        res.status(409).json({ error: "La capacité totale des tables dépasserait celle de la salle" });
        return;
      }
    }
  }
  try {
    const [updated] = await db
      .update(guestTablesTable)
      .set(body.data)
      .where(eq(guestTablesTable.id, table.id))
      .returning();
    const [usage] = await db
      .select({ occupiedSeats: sql<number>`coalesce(sum(${guestsTable.partySize}), 0)::int` })
      .from(guestsTable)
      .where(eq(guestsTable.tableId, table.id));
    res.json({ ...updated, occupiedSeats: usage?.occupiedSeats ?? 0 });
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Une table porte déjà ce nom dans cet événement" });
      return;
    }
    throw error;
  }
});

router.delete("/tables/:tableId", requireUser, async (req, res): Promise<void> => {
  const params = DeleteTableParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deleted] = await db
    .delete(guestTablesTable)
    .where(eq(guestTablesTable.id, params.data.tableId))
    .returning({ id: guestTablesTable.id });
  if (!deleted) {
    res.status(404).json({ error: "Table introuvable" });
    return;
  }
  res.sendStatus(204);
});

router.get("/events/:eventId/guests", requireUser, async (req, res): Promise<void> => {
  const params = ListEventGuestsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select({
      id: guestsTable.id,
      eventId: guestsTable.eventId,
      fullName: guestsTable.fullName,
      groupType: guestsTable.groupType,
      partySize: guestsTable.partySize,
      category: guestsTable.category,
      tableId: guestsTable.tableId,
      tableName: guestTablesTable.name,
      invitationCode: guestsTable.invitationCode,
      invitationStatus: guestsTable.invitationStatus,
      sharedAt: guestsTable.sharedAt,
      rsvpStatus: guestsTable.rsvpStatus,
      checkedInAt: guestsTable.checkedInAt,
      createdAt: guestsTable.createdAt,
    })
    .from(guestsTable)
    .leftJoin(guestTablesTable, eq(guestsTable.tableId, guestTablesTable.id))
    .where(eq(guestsTable.eventId, params.data.eventId))
    .orderBy(asc(guestsTable.fullName));
  res.json(rows.map((guest) => ({ ...guest, invitationUrl: invitePath(guest.invitationCode) })));
});

router.post("/events/:eventId/guests", requireUser, async (req, res): Promise<void> => {
  const params = CreateGuestParams.safeParse(req.params);
  const body = CreateGuestBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!groupSizeIsValid(body.data.groupType, body.data.partySize)) {
    res.status(400).json({ error: "Le nombre de personnes ne correspond pas au type de groupe choisi" });
    return;
  }
  const event = await findEvent(params.data.eventId);
  if (!event) {
    res.status(404).json({ error: "Événement introuvable" });
    return;
  }
  let guest: { id: string } | undefined;
  try {
    guest = await db.transaction(async (tx) => {
      const available = await tableAvailable(tx, event.id, body.data.tableId, body.data.partySize);
      if (!available.ok) throw new CapacityError(available.error);
      const code = randomBytes(9).toString("base64url").toUpperCase();
      const [created] = await tx
        .insert(guestsTable)
        .values({ eventId: event.id, ...body.data, invitationCode: code })
        .returning({ id: guestsTable.id });
      return created;
    });
  } catch (error) {
    if (error instanceof CapacityError) {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
  const result = await buildGuest(event.id, guest.id);
  res.status(201).json(result);
});

router.patch("/guests/:guestId", requireUser, async (req, res): Promise<void> => {
  const params = UpdateGuestParams.safeParse(req.params);
  const body = UpdateGuestBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [existing] = await db.select().from(guestsTable).where(eq(guestsTable.id, params.data.guestId));
  if (!existing) {
    res.status(404).json({ error: "Invité introuvable" });
    return;
  }
  const groupType = body.data.groupType ?? existing.groupType;
  const partySize = body.data.partySize ?? existing.partySize;
  if (!groupSizeIsValid(groupType, partySize)) {
    res.status(400).json({ error: "Le nombre de personnes ne correspond pas au type de groupe choisi" });
    return;
  }
  const tableId = body.data.tableId === undefined ? existing.tableId : body.data.tableId;
  try {
    await db.transaction(async (tx) => {
      const available = await tableAvailable(tx, existing.eventId, tableId, partySize, existing.id);
      if (!available.ok) throw new CapacityError(available.error);
      await tx.update(guestsTable).set(body.data).where(eq(guestsTable.id, existing.id));
    });
  } catch (error) {
    if (error instanceof CapacityError) {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
  res.json(await buildGuest(existing.eventId, existing.id));
});

router.delete("/guests/:guestId", requireUser, async (req, res): Promise<void> => {
  const params = DeleteGuestParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deleted] = await db
    .delete(guestsTable)
    .where(eq(guestsTable.id, params.data.guestId))
    .returning({ id: guestsTable.id });
  if (!deleted) {
    res.status(404).json({ error: "Invité introuvable" });
    return;
  }
  res.sendStatus(204);
});

router.post("/guests/:guestId/share", requireUser, async (req, res): Promise<void> => {
  const params = MarkGuestSharedParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [existing] = await db.select().from(guestsTable).where(eq(guestsTable.id, params.data.guestId));
  if (!existing) {
    res.status(404).json({ error: "Invité introuvable" });
    return;
  }
  await db
    .update(guestsTable)
    .set({ invitationStatus: "shared", sharedAt: new Date() })
    .where(eq(guestsTable.id, existing.id));
  res.json(await buildGuest(existing.eventId, existing.id));
});

router.get("/events/:eventId/export.csv", requireUser, async (req, res): Promise<void> => {
  const params = ExportGuestsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const event = await findEvent(params.data.eventId);
  if (!event) {
    res.status(404).json({ error: "Événement introuvable" });
    return;
  }
  const rows = await db
    .select({
      fullName: guestsTable.fullName,
      groupType: guestsTable.groupType,
      partySize: guestsTable.partySize,
      category: guestsTable.category,
      tableName: guestTablesTable.name,
      invitationStatus: guestsTable.invitationStatus,
      sharedAt: guestsTable.sharedAt,
      rsvpStatus: guestsTable.rsvpStatus,
      invitationCode: guestsTable.invitationCode,
      checkedInAt: guestsTable.checkedInAt,
    })
    .from(guestsTable)
    .leftJoin(guestTablesTable, eq(guestsTable.tableId, guestTablesTable.id))
    .where(eq(guestsTable.eventId, event.id))
    .orderBy(asc(guestsTable.fullName));

  const fields = [
    "Nom ou groupe",
    "Type",
    "Nombre de personnes",
    "Catégorie",
    "Table",
    "Invitation partagée",
    "Date de partage",
    "Réponse",
    "Code personnel",
    "Arrivée",
  ];
  const csvCell = (value: string | number | Date | null): string => {
    let content = value instanceof Date ? value.toISOString() : String(value ?? "");
    if (/^[=+\-@]/.test(content)) content = `'${content}`;
    return `"${content.replaceAll('"', '""')}"`;
  };
  const content = [fields, ...rows.map((guest) => [
    guest.fullName,
    guest.groupType,
    guest.partySize,
    guest.category,
    guest.tableName,
    guest.invitationStatus === "shared" ? "Oui" : "Non",
    guest.sharedAt,
    guest.rsvpStatus,
    guest.invitationCode,
    guest.checkedInAt ? "Oui" : "Non",
  ])]
    .map((line) => line.map(csvCell).join(";"))
    .join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${safeFileName(event.name)}-invites.csv"`);
  res.send(`\uFEFF${content}`);
});

router.get("/public/invitations/:code", async (req, res): Promise<void> => {
  const params = GetPublicInvitationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select({
      guestName: guestsTable.fullName,
      partySize: guestsTable.partySize,
      rsvpStatus: guestsTable.rsvpStatus,
      eventName: eventsTable.name,
      eventType: eventsTable.type,
      eventAt: eventsTable.eventAt,
      venue: eventsTable.venue,
      invitationUrl: eventsTable.invitationUrl,
      invitationImageUrl: eventsTable.invitationImageUrl,
      tableName: guestTablesTable.name,
    })
    .from(guestsTable)
    .innerJoin(eventsTable, eq(guestsTable.eventId, eventsTable.id))
    .leftJoin(guestTablesTable, eq(guestsTable.tableId, guestTablesTable.id))
    .where(eq(guestsTable.invitationCode, params.data.code.toUpperCase()))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Cette invitation est introuvable" });
    return;
  }
  res.json(row);
});

router.post("/public/invitations/:code/rsvp", async (req, res): Promise<void> => {
  const params = RespondToInvitationParams.safeParse(req.params);
  const body = RespondToInvitationBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [guest] = await db
    .update(guestsTable)
    .set({ rsvpStatus: body.data.status })
    .where(eq(guestsTable.invitationCode, params.data.code.toUpperCase()))
    .returning({ id: guestsTable.id });
  if (!guest) {
    res.status(404).json({ error: "Cette invitation est introuvable" });
    return;
  }
  const [row] = await db
    .select({
      guestName: guestsTable.fullName,
      partySize: guestsTable.partySize,
      rsvpStatus: guestsTable.rsvpStatus,
      eventName: eventsTable.name,
      eventType: eventsTable.type,
      eventAt: eventsTable.eventAt,
      venue: eventsTable.venue,
      invitationUrl: eventsTable.invitationUrl,
      invitationImageUrl: eventsTable.invitationImageUrl,
      tableName: guestTablesTable.name,
    })
    .from(guestsTable)
    .innerJoin(eventsTable, eq(guestsTable.eventId, eventsTable.id))
    .leftJoin(guestTablesTable, eq(guestsTable.tableId, guestTablesTable.id))
    .where(eq(guestsTable.id, guest.id))
    .limit(1);
  res.json(row);
});

router.post("/events/:eventId/check-ins", requireUser, async (req, res): Promise<void> => {
  const params = CheckInGuestParams.safeParse(req.params);
  const body = CheckInGuestBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [guest] = await db
    .select({ id: guestsTable.id, checkedInAt: guestsTable.checkedInAt })
    .from(guestsTable)
    .where(
      and(
        eq(guestsTable.eventId, params.data.eventId),
        eq(guestsTable.invitationCode, body.data.invitationCode.toUpperCase()),
      ),
    )
    .limit(1);
  if (!guest) {
    res.status(404).json({ error: "Code inconnu pour cet événement" });
    return;
  }

  const alreadyCheckedIn = guest.checkedInAt !== null;
  if (!alreadyCheckedIn) {
    await db
      .update(guestsTable)
      .set({ checkedInAt: new Date() })
      .where(and(eq(guestsTable.id, guest.id), isNull(guestsTable.checkedInAt)));
  }
  const guestDetails = await buildGuest(params.data.eventId, guest.id);
  if (!guestDetails) {
    res.status(404).json({ error: "Invité introuvable" });
    return;
  }
  res.json({
    guest: guestDetails,
    alreadyCheckedIn,
    message: alreadyCheckedIn ? "Cette invitation a déjà été contrôlée" : "Arrivée enregistrée",
  });
});

router.post("/events/:eventId/check-ins/offline-sync", requireUser, async (req, res): Promise<void> => {
  const params = SyncOfflineCheckInsParams.safeParse(req.params);
  const body = SyncOfflineCheckInsBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  let synced = 0;
  let alreadyCheckedIn = 0;
  const notFound: string[] = [];
  await db.transaction(async (tx) => {
    for (const item of body.data.items) {
      const [guest] = await tx
        .select({ id: guestsTable.id, checkedInAt: guestsTable.checkedInAt })
        .from(guestsTable)
        .where(
          and(
            eq(guestsTable.eventId, params.data.eventId),
            eq(guestsTable.invitationCode, item.invitationCode.toUpperCase()),
          ),
        )
        .limit(1);
      if (!guest) {
        notFound.push(item.invitationCode);
        continue;
      }
      const [saved] = await tx
        .insert(offlineCheckInsTable)
        .values({
          eventId: params.data.eventId,
          guestId: guest.id,
          idempotencyKey: item.idempotencyKey,
          checkedInAt: new Date(item.checkedInAt),
        })
        .onConflictDoNothing()
        .returning({ idempotencyKey: offlineCheckInsTable.idempotencyKey });
      if (!saved) {
        alreadyCheckedIn += 1;
        continue;
      }
      if (guest.checkedInAt) {
        alreadyCheckedIn += 1;
      } else {
        await tx
          .update(guestsTable)
          .set({ checkedInAt: new Date(item.checkedInAt) })
          .where(and(eq(guestsTable.id, guest.id), isNull(guestsTable.checkedInAt)));
        synced += 1;
      }
    }
  });
  res.json({ synced, alreadyCheckedIn, notFound });
});

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function safeFileName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "evenement";
}

export default router;
