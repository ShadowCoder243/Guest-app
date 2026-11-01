import { asc, eq, sql } from "drizzle-orm";
import { Router, type IRouter, type RequestHandler } from "express";
import {
  CreateEventBody,
  DeleteEventParams,
  GetEventParams,
  GetEventResponse,
  GetEventsResponse,
  GetEventDashboardParams,
  GetEventDashboardResponse,
  UpdateEventBody,
  UpdateEventParams,
} from "@workspace/api-zod";
import { db, eventsTable, guestTablesTable, guestsTable } from "@workspace/db";
import { canAccessEvent, requireUser } from "../middlewares/auth";

const router: IRouter = Router();

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

router.use("/events/:eventId", requireAccessibleEvent);

router.get("/events", requireUser, async (_req, res): Promise<void> => {
  const events = _req.user!.role === "admin"
    ? await db.select().from(eventsTable).orderBy(asc(eventsTable.eventAt))
    : await db
        .select()
        .from(eventsTable)
        .where(eq(eventsTable.createdBy, _req.user!.id))
        .orderBy(asc(eventsTable.eventAt));
  res.json(GetEventsResponse.parse(events));
});

router.post("/events", requireUser, async (req, res): Promise<void> => {
  const parsed = CreateEventBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [event] = await db
    .insert(eventsTable)
    .values({ ...parsed.data, createdBy: req.user!.id })
    .returning();
  res.status(201).json(GetEventResponse.parse(event));
});

router.get("/events/:eventId", requireUser, async (req, res): Promise<void> => {
  const params = GetEventParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [event] = await db.select().from(eventsTable).where(eq(eventsTable.id, params.data.eventId));
  if (!event) {
    res.status(404).json({ error: "Événement introuvable" });
    return;
  }
  res.json(GetEventResponse.parse(event));
});

router.patch("/events/:eventId", requireUser, async (req, res): Promise<void> => {
  const params = UpdateEventParams.safeParse(req.params);
  const parsed = UpdateEventBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [event] = await db
    .update(eventsTable)
    .set(parsed.data)
    .where(eq(eventsTable.id, params.data.eventId))
    .returning();
  if (!event) {
    res.status(404).json({ error: "Événement introuvable" });
    return;
  }
  res.json(GetEventResponse.parse(event));
});

router.delete("/events/:eventId", requireUser, async (req, res): Promise<void> => {
  const params = DeleteEventParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deleted] = await db.delete(eventsTable).where(eq(eventsTable.id, params.data.eventId)).returning({ id: eventsTable.id });
  if (!deleted) {
    res.status(404).json({ error: "Événement introuvable" });
    return;
  }
  res.sendStatus(204);
});

router.get("/events/:eventId/dashboard", requireUser, async (req, res): Promise<void> => {
  const params = GetEventDashboardParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [event] = await db.select().from(eventsTable).where(eq(eventsTable.id, params.data.eventId));
  if (!event) {
    res.status(404).json({ error: "Événement introuvable" });
    return;
  }

  const [counts] = await db
    .select({
      totalGroups: sql<number>`count(*)::int`,
      totalPeople: sql<number>`coalesce(sum(${guestsTable.partySize}), 0)::int`,
      invitationsShared: sql<number>`count(*) filter (where ${guestsTable.invitationStatus} = 'shared')::int`,
      confirmedPeople: sql<number>`coalesce(sum(${guestsTable.partySize}) filter (where ${guestsTable.rsvpStatus} = 'attending'), 0)::int`,
      declinedGroups: sql<number>`count(*) filter (where ${guestsTable.rsvpStatus} = 'declined')::int`,
      checkedInPeople: sql<number>`coalesce(sum(${guestsTable.partySize}) filter (where ${guestsTable.checkedInAt} is not null), 0)::int`,
      seatedPeople: sql<number>`coalesce(sum(${guestsTable.partySize}) filter (where ${guestsTable.tableId} is not null), 0)::int`,
    })
    .from(guestsTable)
    .where(eq(guestsTable.eventId, event.id));
  const tableRows = await db.select({ id: guestTablesTable.id }).from(guestTablesTable).where(eq(guestTablesTable.eventId, event.id));
  const recentRows = await db
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
    .where(eq(guestsTable.eventId, event.id))
    .orderBy(sql`${guestsTable.createdAt} desc`)
    .limit(5);
  const recentGuests = recentRows.map((guest) => ({
    ...guest,
    invitationUrl: `/invite/${guest.invitationCode}`,
  }));
  res.json(
    GetEventDashboardResponse.parse({
      ...counts,
      tableCount: tableRows.length,
      roomCapacity: event.roomCapacity,
      recentGuests,
    }),
  );
});

export default router;
