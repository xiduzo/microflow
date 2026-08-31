import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

// Custom bytea type for storing binary data
const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return "bytea";
  },
  toDriver(value: Buffer): Buffer {
    return value;
  },
  fromDriver(value: unknown): Buffer {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (typeof value === "string") return Buffer.from(value, "hex");
    return Buffer.from(value as ArrayBuffer);
  },
});

export const flow = pgTable(
  "flow",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    color: text("color").default("#4338ca").notNull(),
    // Yjs document state stored as binary
    ydoc: bytea("ydoc"),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Community publishing: a published flow is a frozen snapshot, never the
    // live doc. `publishedAt IS NOT NULL` is the visibility flag.
    description: text("description"),
    publishedYdoc: bytea("published_ydoc"),
    publishedAt: timestamp("published_at"),
    // The community flow this one was copied from, for attribution.
    forkedFromId: text("forked_from_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("flow_ownerId_idx").on(table.ownerId),
    index("flow_publishedAt_idx").on(table.publishedAt),
  ]
);

/**
 * A user saved a community flow. Doubles as the popularity signal:
 * bookmark counts rank community flows.
 */
export const flowBookmark = pgTable(
  "flow_bookmark",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id")
      .notNull()
      .references(() => flow.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("flow_bookmark_userId_idx").on(table.userId),
    index("flow_bookmark_flowId_idx").on(table.flowId),
    uniqueIndex("flow_bookmark_flowId_userId_idx").on(
      table.flowId,
      table.userId
    ),
  ]
);

export const flowCollaborator = pgTable(
  "flow_collaborator",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id")
      .notNull()
      .references(() => flow.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["viewer", "editor"] })
      .notNull()
      .default("viewer"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("flow_collaborator_flowId_idx").on(table.flowId),
    index("flow_collaborator_userId_idx").on(table.userId),
    // One grant per user per flow — lets every grant path upsert instead of
    // check-then-insert. See `flow-invitation.ts`.
    uniqueIndex("flow_collaborator_flowId_userId_idx").on(
      table.flowId,
      table.userId
    ),
  ]
);

/**
 * Pending share invitation for an email that has no Microflow account yet.
 * Converted into a `flowCollaborator` when that email signs up (see the
 * better-auth `user.create.after` hook in @microflow/auth).
 */
export const flowInvite = pgTable(
  "flow_invite",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id")
      .notNull()
      .references(() => flow.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ["viewer", "editor"] })
      .notNull()
      .default("viewer"),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("flow_invite_flowId_email_idx").on(table.flowId, table.email),
    index("flow_invite_email_idx").on(table.email),
  ]
);

export const flowRelations = relations(flow, ({ one, many }) => ({
  owner: one(user, {
    fields: [flow.ownerId],
    references: [user.id],
  }),
  collaborators: many(flowCollaborator),
  bookmarks: many(flowBookmark),
}));

export const flowBookmarkRelations = relations(flowBookmark, ({ one }) => ({
  flow: one(flow, {
    fields: [flowBookmark.flowId],
    references: [flow.id],
  }),
  user: one(user, {
    fields: [flowBookmark.userId],
    references: [user.id],
  }),
}));

export const flowCollaboratorRelations = relations(
  flowCollaborator,
  ({ one }) => ({
    flow: one(flow, {
      fields: [flowCollaborator.flowId],
      references: [flow.id],
    }),
    user: one(user, {
      fields: [flowCollaborator.userId],
      references: [user.id],
    }),
  })
);
