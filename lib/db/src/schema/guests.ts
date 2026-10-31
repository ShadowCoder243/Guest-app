import {
  pgEnum,
  pgTable,
  timestamp,
  uuid,
  varchar,
  integer,
  index,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { eventsTable } from "./events";

export const guestGroupEnum = pgEnum("guest_group", ["single", "couple", "family", "group"]);
export const invitationStatusEnum = pgEnum("invitation_status", ["draft", "shared"]);
export const rsvpStatusEnum = pgEnum("rsvp_status", ["pending", "attending", "declined"]);

export const guestTablesTable = pgTable(
  "guest_tables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => eventsTable.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 80 }).notNull(),
    capacity: integer("capacity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("guest_tables_event_name_unique").on(table.eventId, table.name),
    index("guest_tables_event_idx").on(table.eventId),
    check("guest_tables_capacity_positive", sql`${table.capacity} > 0`),
  ],
);

export const guestsTable = pgTable(
  "guests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => eventsTable.id, { onDelete: "cascade" }),
    fullName: varchar("full_name", { length: 160 }).notNull(),
    groupType: guestGroupEnum("group_type").notNull().default("single"),
    partySize: integer("party_size").notNull().default(1),
    category: varchar("category", { length: 80 }).notNull().default("Amis"),
    tableId: uuid("table_id").references(() => guestTablesTable.id, { onDelete: "set null" }),
    invitationCode: varchar("invitation_code", { length: 64 }).notNull().unique(),
    invitationStatus: invitationStatusEnum("invitation_status").notNull().default("draft"),
    sharedAt: timestamp("shared_at", { withTimezone: true }),
    rsvpStatus: rsvpStatusEnum("rsvp_status").notNull().default("pending"),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("guests_event_idx").on(table.eventId),
    index("guests_event_name_idx").on(table.eventId, table.fullName),
    index("guests_table_idx").on(table.tableId),
    check("guests_party_size_positive", sql`${table.partySize} > 0`),
  ],
);

export const offlineCheckInsTable = pgTable(
  "offline_check_ins",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => eventsTable.id, { onDelete: "cascade" }),
    idempotencyKey: varchar("idempotency_key", { length: 80 }).notNull(),
    guestId: uuid("guest_id")
      .notNull()
      .references(() => guestsTable.id, { onDelete: "cascade" }),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("offline_checkins_event_key_unique").on(table.eventId, table.idempotencyKey),
    index("offline_checkins_guest_idx").on(table.guestId),
  ],
);
