import { relations } from "drizzle-orm";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * The Collab identity of a user who never chose one: the column defaults
 * below, and what a reader shows for a user with no settings row yet.
 */
export const DEFAULT_COLLAB_IDENTITY = {
  collabColor: "#4338ca",
  collabIcon: "Cat",
} as const;

export const userSettings = pgTable("user_settings", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  collabColor: text("collab_color").default(DEFAULT_COLLAB_IDENTITY.collabColor).notNull(),
  collabIcon: text("collab_icon").default(DEFAULT_COLLAB_IDENTITY.collabIcon).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const userSettingsRelations = relations(userSettings, ({ one }) => ({
  user: one(user, {
    fields: [userSettings.userId],
    references: [user.id],
  }),
}));
