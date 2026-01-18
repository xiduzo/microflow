import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  index,
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("flow_ownerId_idx").on(table.ownerId)]
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
  ]
);

export const flowRelations = relations(flow, ({ one, many }) => ({
  owner: one(user, {
    fields: [flow.ownerId],
    references: [user.id],
  }),
  collaborators: many(flowCollaborator),
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
