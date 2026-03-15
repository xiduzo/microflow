import { z } from "zod";
import { eq, and, like, ne, inArray } from "drizzle-orm";
import { db } from "@microflow/db";
import { flow, flowCollaborator } from "@microflow/db/schema/flow";
import { user } from "@microflow/db/schema/auth";
import { userSettings } from "@microflow/db/schema/user-settings";
import { protectedProcedure, router } from "../index";
import { FlowDocument } from "@microflow/collab/server";

// ============================================================================
// Constants
// ============================================================================

// Tailwind -300 colors for flow color picker
export const FLOW_COLORS = [
  "#fca5a5", // red-300
  "#fdba74", // orange-300
  "#fcd34d", // amber-300
  "#fde047", // yellow-300
  "#bef264", // lime-300
  "#86efac", // green-300
  "#6ee7b7", // emerald-300
  "#5eead4", // teal-300
  "#67e8f9", // cyan-300
  "#7dd3fc", // sky-300
  "#93c5fd", // blue-300
  "#a5b4fc", // indigo-300
  "#c4b5fd", // violet-300
  "#d8b4fe", // purple-300
  "#f0abfc", // fuchsia-300
  "#f9a8d4", // pink-300
  "#fda4af", // rose-300
] as const;

// ============================================================================
// Helpers
// ============================================================================

const uid = () =>
  Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

function decodeFlowData(ydoc: Buffer | null) {
  if (!ydoc) return { nodes: [], edges: [] };
  try {
    const flowDoc = FlowDocument.decode(new Uint8Array(ydoc));
    return flowDoc.getFlowData();
  } catch {
    return { nodes: [], edges: [] };
  }
}

// ============================================================================
// Router
// ============================================================================

export const flowRouter = router({
  /**
   * List all flows the user owns or collaborates on
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;

    // Get flows where user is owner
    const ownedFlowsRaw = await db.query.flow.findMany({
      where: eq(flow.ownerId, userId),
      columns: {
        id: true,
        name: true,
        color: true,
        createdAt: true,
        updatedAt: true,
        ydoc: true,
      },
    });

    const ownedFlows = ownedFlowsRaw.map((f) => {
      const { ydoc, ...rest } = f;
      return { ...rest, ...decodeFlowData(ydoc) };
    });

    // Get flows where user is collaborator
    const collaborations = await db.query.flowCollaborator.findMany({
      where: eq(flowCollaborator.userId, userId),
      with: {
        flow: {
          columns: {
            id: true,
            name: true,
            color: true,
            createdAt: true,
            updatedAt: true,
            ydoc: true,
          },
        },
      },
    });

    const collaboratedFlows = collaborations.map((c) => {
      const { ydoc, ...rest } = c.flow;
      return { ...rest, ...decodeFlowData(ydoc), role: c.role };
    });

    return {
      owned: ownedFlows,
      collaborated: collaboratedFlows,
    };
  }),

  /**
   * Get a single flow by ID
   */
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      const flowRecord = await db.query.flow.findFirst({
        where: eq(flow.id, input.id),
        with: {
          owner: {
            columns: { id: true, name: true, email: true, image: true },
          },
          collaborators: {
            columns: { role: true },
            with: {
              user: {
                columns: { id: true, name: true, email: true, image: true },
              },
            },
          },
        },
      });

      if (!flowRecord) {
        throw new Error("Flow not found");
      }

      // Check access
      const isOwner = flowRecord.ownerId === userId;
      const isCollaborator = flowRecord.collaborators.some(
        ({ user }) => user.id === userId
      );

      if (!isOwner && !isCollaborator) {
        throw new Error("Access denied");
      }

      // Fetch collabColor and collabIcon for owner and all collaborators
      const userIds = [
        flowRecord.owner.id,
        ...flowRecord.collaborators.map((c) => c.user.id),
      ];
      const settingsRows =
        userIds.length > 0
          ? await db.query.userSettings.findMany({
              where: inArray(userSettings.userId, userIds),
              columns: { userId: true, collabColor: true, collabIcon: true },
            })
          : [];
      const settingsByUser = new Map(
        settingsRows.map((s) => [
          s.userId,
          {
            collabColor: s.collabColor,
            collabIcon: s.collabIcon,
          },
        ])
      );
      const withCollab = (uid: string) => ({
        collabColor: settingsByUser.get(uid)?.collabColor ?? "#4338ca",
        collabIcon: settingsByUser.get(uid)?.collabIcon ?? "Cat",
      });

      // Decode ydoc to get nodes/edges
      const { nodes, edges } = decodeFlowData(flowRecord.ydoc);

      // Return ydoc as base64 for client to initialize FlowDocument
      const ydocBase64 = flowRecord.ydoc
        ? Buffer.from(flowRecord.ydoc).toString("base64")
        : null;

      return {
        id: flowRecord.id,
        name: flowRecord.name,
        color: flowRecord.color,
        createdAt: flowRecord.createdAt,
        updatedAt: flowRecord.updatedAt,
        owner: { ...flowRecord.owner, ...withCollab(flowRecord.owner.id) },
        collaborators: flowRecord.collaborators.map((c) => ({
          ...c,
          user: { ...c.user, ...withCollab(c.user.id) },
        })),
        nodes,
        edges,
        ydocBase64,
        isOwner,
        role: isOwner
          ? "owner"
          : flowRecord.collaborators.find((c) => c.user.id === userId)?.role,
      };
    }),

  /**
   * Create a new flow
   */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        color: z
          .string()
          .regex(/^#[0-9A-Fa-f]{6}$/)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const id = uid();

      // Create empty FlowDocument and encode it
      const flowDoc = FlowDocument.createEmpty();
      flowDoc.setMeta({ name: input.name });
      const ydocData = flowDoc.encode();

      const [createdFlow] = await db.insert(flow).values({
        id,
        name: input.name,
        color: input.color,
        ownerId: ctx.session.user.id,
        ydoc: Buffer.from(ydocData),
      }).returning({
        id: flow.id,
        name: flow.name,
      });

      flowDoc.destroy();

      return createdFlow;
    }),

  /**
   * Create a new flow from imported data (nodes + edges)
   */
  createFromImport: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        color: z
          .string()
          .regex(/^#[0-9A-Fa-f]{6}$/)
          .optional(),
        nodes: z.array(z.any()),
        edges: z.array(z.any()),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const id = uid();

      const flowDoc = FlowDocument.createEmpty();
      flowDoc.setMeta({ name: input.name });
      flowDoc.setFlowData(input.nodes, input.edges);
      const ydocData = flowDoc.encode();

      const [createdFlow] = await db.insert(flow).values({
        id,
        name: input.name,
        color: input.color,
        ownerId: ctx.session.user.id,
        ydoc: Buffer.from(ydocData),
      }).returning({
        id: flow.id,
        name: flow.name,
      });

      flowDoc.destroy();

      return createdFlow;
    }),

  /**
   * Update flow metadata
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(100).optional(),
        color: z
          .string()
          .regex(/^#[0-9A-Fa-f]{6}$/)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const flowRecord = await db.query.flow.findFirst({
        where: eq(flow.id, input.id),
      });

      if (!flowRecord || flowRecord.ownerId !== ctx.session.user.id) {
        throw new Error("Flow not found or access denied");
      }

      const updatedFlow = await db
        .update(flow)
        .set({
          name: input.name,
          color: input.color,
          updatedAt: new Date(),
        })
        .where(eq(flow.id, input.id))
        .returning();

      return updatedFlow;
    }),

  /**
   * Delete a flow
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const flowRecord = await db.query.flow.findFirst({
        where: eq(flow.id, input.id),
      });

      if (!flowRecord || flowRecord.ownerId !== ctx.session.user.id) {
        throw new Error("Flow not found or access denied");
      }

      await db.delete(flow).where(eq(flow.id, input.id));

      return flowRecord;
    }),

  /**
   * Add a collaborator to a flow
   */
  addCollaborator: protectedProcedure
    .input(
      z.object({
        flowId: z.string(),
        userId: z.string(),
        role: z.enum(["viewer", "editor"]).default("viewer"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const flowRecord = await db.query.flow.findFirst({
        where: eq(flow.id, input.flowId),
      });

      if(!flowRecord) {
        throw new Error("Flow not found");
      }

      if (flowRecord.ownerId !== ctx.session.user.id) {
        throw new Error("Access denied");
      }

      const id = uid();
      await db.insert(flowCollaborator).values({
        id,
        flowId: input.flowId,
        userId: input.userId,
        role: input.role,
      });

      return { success: true };
    }),

  /**
   * Remove a collaborator from a flow
   */
  removeCollaborator: protectedProcedure
    .input(
      z.object({
        flowId: z.string(),
        userId: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const flowRecord = await db.query.flow.findFirst({
        where: eq(flow.id, input.flowId),
      });

      if(!flowRecord) {
        throw new Error("Flow not found");
      }

      if (flowRecord.ownerId !== ctx.session.user.id) {
        throw new Error("Access denied");
      }

      await db
        .delete(flowCollaborator)
        .where(
          and(
            eq(flowCollaborator.flowId, input.flowId),
            eq(flowCollaborator.userId, input.userId)
          )
        )

      return { success: true };
    }),

  /**
   * Search users by email for adding collaborators
   */
  searchUsers: protectedProcedure
    .input(z.object({ query: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const users = await db.query.user.findMany({
        where: and(
          like(user.email, `%${input.query}%`),
          ne(user.id, ctx.session.user.id)
        ),
        columns: {
          id: true,
          name: true,
          email: true,
          image: true,
        },
        limit: 10,
      });
      return users;
    }),

  /**
   * Add a collaborator by email
   */
  addCollaboratorByEmail: protectedProcedure
    .input(
      z.object({
        flowId: z.string(),
        email: z.string().email(),
        role: z.enum(["viewer", "editor"]).default("viewer"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const flowRecord = await db.query.flow.findFirst({
        where: eq(flow.id, input.flowId),
      });

      if (!flowRecord || flowRecord.ownerId !== ctx.session.user.id) {
        throw new Error("Flow not found or access denied");
      }

      // Find user by email
      const targetUser = await db.query.user.findFirst({
        where: eq(user.email, input.email),
      });

      if (!targetUser) {
        throw new Error("User not found");
      }

      if (targetUser.id === ctx.session.user.id) {
        throw new Error("Cannot add yourself as a collaborator");
      }

      // Check if already a collaborator
      const existing = await db.query.flowCollaborator.findFirst({
        where: and(
          eq(flowCollaborator.flowId, input.flowId),
          eq(flowCollaborator.userId, targetUser.id)
        ),
      });

      if (existing) {
        throw new Error("User is already a collaborator");
      }

      const id = uid();
      await db.insert(flowCollaborator).values({
        id,
        flowId: input.flowId,
        userId: targetUser.id,
        role: input.role,
      });

      return { success: true, userId: targetUser.id };
    }),
    /**
     * Update a collaborator's role
     */
    updateCollaboratorRole: protectedProcedure
      .input(z.object({ flowId: z.string(), userId: z.string(), role: z.enum(["viewer", "editor"]).default("viewer") }))
      .mutation(async ({ ctx, input }) => {
        const flowRecord = await db.query.flow.findFirst({
          where: eq(flow.id, input.flowId),
        });

        if(!flowRecord) {
          throw new Error("Flow not found");
        }

        if(flowRecord.ownerId !== ctx.session.user.id) {
          throw new Error("Access denied");
        }

        const collaborator = await db.query.flowCollaborator.findFirst({
          where: and(eq(flowCollaborator.flowId, input.flowId), eq(flowCollaborator.userId, input.userId)),
        });
        
        if(!collaborator) {
          throw new Error("Collaborator not found");
        }

        await db.update(flowCollaborator).set({ role: input.role }).where(eq(flowCollaborator.id, collaborator.id));

        return { success: true };
      }),
});
