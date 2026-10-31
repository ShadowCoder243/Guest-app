import { pgTable, timestamp, uuid, varchar, integer, text, index } from "drizzle-orm/pg-core";

export const eventsTable = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 160 }).notNull(),
    type: varchar("type", { length: 60 }).notNull(),
    eventAt: timestamp("event_at", { withTimezone: true }),
    venue: varchar("venue", { length: 300 }),
    invitationUrl: text("invitation_url"),
    invitationImageUrl: text("invitation_image_url"),
    expectedGuests: integer("expected_guests"),
    roomCapacity: integer("room_capacity"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("events_date_idx").on(table.eventAt)],
);
