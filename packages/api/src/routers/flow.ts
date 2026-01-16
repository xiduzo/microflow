import { z } from "zod";
import { eq, and, like, ne } from "drizzle-orm";
import { db } from "@microflow/db";
import { flow, flowCollaborator } from "@microflow/db/schema/flow";
import { user } from "@microflow/db/schema/auth";
import { protectedProcedure, router } from "../index";
// import { decodeYDoc, getFlowData } from "@microflow/collab";

const uid = () =>
  Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

export const flowRouter = router({
  /** List all flows the user owns or collaborates on */
  list: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;

    const { decodeYDoc, getFlowData } = await import("@microflow/collab");

    // Helper to decode ydoc and get nodes/edges
    const decodeFlowData = (ydoc: Buffer | null) => {
      if (!ydoc) return { nodes: [], edges: [] };
      const doc = decodeYDoc(ydoc);
      const flowData = getFlowData(doc);
      return { nodes: flowData.nodes, edges: flowData.edges };
    };

    // Get flows where user is owner
    const ownedFlowsRaw = await db.query.flow.findMany({
      where: eq(flow.ownerId, userId),
      columns: {
        id: true,
        name: true,
        description: true,
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

  /** Get a single flow by ID */
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      const flowRecord = await db.query.flow.findFirst({
        where: eq(flow.id, input.id),
        with: {
          owner: {
            columns: { id: true, name: true, image: true },
          },
          collaborators: {
            with: {
              user: {
                columns: { id: true, name: true, image: true },
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
        (c) => c.userId === userId
      );

      if (!isOwner && !isCollaborator) {
        throw new Error("Access denied");
      }

      // Decode ydoc to get nodes/edges if available
      let nodes: unknown[] = [];
      let edges: unknown[] = [];
      if (flowRecord.ydoc) {
        const { decodeYDoc, getFlowData } = await import("@microflow/collab");
        const doc = decodeYDoc(flowRecord.ydoc);
        const flowData = getFlowData(doc);
        nodes = flowData.nodes;
        edges = flowData.edges;
      }

      return {
        ...flowRecord,
        nodes,
        edges,
        isOwner,
        role: isOwner
          ? "owner"
          : flowRecord.collaborators.find((c) => c.userId === userId)?.role,
      };
    }),

  /** Create a new flow */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        description: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const id = uid();

      await db.insert(flow).values({
        id,
        name: input.name,
        description: input.description,
        ownerId: ctx.session.user.id,
      });

      return { id };
    }),

  /** Update flow metadata */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const flowRecord = await db.query.flow.findFirst({
        where: eq(flow.id, input.id),
      });

      if (!flowRecord || flowRecord.ownerId !== ctx.session.user.id) {
        throw new Error("Flow not found or access denied");
      }

      await db
        .update(flow)
        .set({
          name: input.name,
          description: input.description,
        })
        .where(eq(flow.id, input.id));

      return { success: true };
    }),

  /** Delete a flow */
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

      return { success: true };
    }),

  /** Add a collaborator to a flow */
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

      if (!flowRecord || flowRecord.ownerId !== ctx.session.user.id) {
        throw new Error("Flow not found or access denied");
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

  /** Remove a collaborator from a flow */
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

      if (!flowRecord || flowRecord.ownerId !== ctx.session.user.id) {
        throw new Error("Flow not found or access denied");
      }

      await db
        .delete(flowCollaborator)
        .where(
          and(
            eq(flowCollaborator.flowId, input.flowId),
            eq(flowCollaborator.userId, input.userId)
          )
        );

      return { success: true };
    }),

  /** Search users by email for adding collaborators */
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

  /** Add a collaborator by email */
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
});
