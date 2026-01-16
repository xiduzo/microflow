import { z } from "zod";
import { eq, or, and } from "drizzle-orm";
import { db } from "@microflow/db";
import { flow, flowCollaborator } from "@microflow/db/schema";
import { protectedProcedure, router } from "../index";

const uid = () => Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

export const flowRouter = router({
  /** List all flows the user owns or collaborates on */
  list: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;

    // Get flows where user is owner
    const ownedFlows = await db.query.flow.findMany({
      where: eq(flow.ownerId, userId),
      columns: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Get flows where user is collaborator
    const collaborations = await db.query.flowCollaborator.findMany({
      where: eq(flowCollaborator.userId, userId),
      with: {
        flow: {
          columns: {
            id: true,
            name: true,
            description: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    const collaboratedFlows = collaborations.map((c) => ({
      ...c.flow,
      role: c.role,
    }));

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

      return {
        ...flowRecord,
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
});
