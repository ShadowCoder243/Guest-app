import { pgEnum, pgTable, timestamp, uuid, varchar, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const userRoleEnum = pgEnum("user_role", ["admin", "organizer"]);

export const usersTable = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: varchar("username", { length: 40 }).notNull().unique(),
    displayName: varchar("display_name", { length: 100 }).notNull(),
    passcodeHash: varchar("passcode_hash", { length: 128 }).notNull(),
    passcodeSalt: varchar("passcode_salt", { length: 64 }).notNull(),
    role: userRoleEnum("role").notNull().default("organizer"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("users_active_idx").on(table.active),
    uniqueIndex("users_one_admin_idx")
      .on(table.role)
      .where(sql`${table.role} = 'admin'`),
  ],
);

export const sessionsTable = pgTable(
  "sessions",
  {
    tokenHash: varchar("token_hash", { length: 64 }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);
