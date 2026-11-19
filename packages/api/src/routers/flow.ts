import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, and, like, ne } from "drizzle-orm";
import { db } from "@microflow/db";
import { flowCollaborator } from "@microflow/db/schema/flow";
import { user } from "@microflow/db/schema/auth";
import { protectedProcedure, router } from "../index";
import { requireFlowAccess, setFlowRole } from "./flow-access";
import {
  createFlow,
  deleteFlow,
  listFlows,
  openFlow,
  publishFlow,
  unpublishFlow,
  updateFlow,
} from "./flow-library";
import {
  inviteByEmail,
  listPendingInvites,
  revokeInvite,
} from "@microflow/db/flow-invitation";
import { resendInviteMailer } from "./invite-mailer";

// ============================================================================
// Router — each procedure validates its input, runs the Flow Access check,
// and makes one call into the Flow library (or Flow Invitation / setFlowRole
// for the collaborator procedures).
// ============================================================================

const flowName = z.string().min(1).max(100);
const flowColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const flowRouter = router({
  /**
   * List all flows the user owns or collaborates on
   */
  list: protectedProcedure.query(({ ctx }) => listFlows(ctx.session.user.id)),

  /**
   * Get a single flow by ID
   */
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const { flow: flowRecord, role } = await requireFlowAccess(
        input.id,
        ctx.session.user.id,
        "viewer"
      );

      return {
        ...(await openFlow(flowRecord)),
        isOwner: role === "owner",
        role,
      };
    }),

  /**
   * Create a new flow
   */
  create: protectedProcedure
    .input(z.object({ name: flowName, color: flowColor.optional() }))
    .mutation(({ ctx, input }) => createFlow(ctx.session.user.id, input)),

  /**
   * Create a new flow from imported data (nodes + edges)
   */
  createFromImport: protectedProcedure
    .input(
      z.object({
        name: flowName,
        color: flowColor.optional(),
        nodes: z.array(z.any()),
        edges: z.array(z.any()),
      })
    )
    .mutation(({ ctx, input }) => createFlow(ctx.session.user.id, input)),

  /**
   * Update flow metadata
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: flowName.optional(),
        color: flowColor.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireFlowAccess(input.id, ctx.session.user.id, "owner");

      return updateFlow(input.id, { name: input.name, color: input.color });
    }),

  /**
   * Delete a flow
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { flow: flowRecord } = await requireFlowAccess(
        input.id,
        ctx.session.user.id,
        "owner"
      );

      await deleteFlow(input.id);

      return flowRecord;
    }),

  /**
   * Publish (or republish) a flow to the community: freeze the current doc
   * into a public snapshot. Live edits stay private until the next publish.
   */
  publish: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        description: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireFlowAccess(input.id, ctx.session.user.id, "owner");

      await publishFlow(input.id, input.description);

      return { success: true };
    }),

  /**
   * Remove a flow from the community
   */
  unpublish: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await requireFlowAccess(input.id, ctx.session.user.id, "owner");

      await unpublishFlow(input.id);

      return { success: true };
    }),

  /**
   * Published state for the share dialog, without hauling the whole doc over.
   */
  publishInfo: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const { flow: flowRecord } = await requireFlowAccess(
        input.id,
        ctx.session.user.id,
        "viewer"
      );
      return {
        publishedAt: flowRecord.publishedAt,
        description: flowRecord.description,
      };
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
      await requireFlowAccess(input.flowId, ctx.session.user.id, "owner");

      await setFlowRole(input.flowId, input.userId, input.role);

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
      await requireFlowAccess(input.flowId, ctx.session.user.id, "owner");

      await setFlowRole(input.flowId, input.userId, null);

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
      const { flow: flowRecord } = await requireFlowAccess(
        input.flowId,
        ctx.session.user.id,
        "owner"
      );

      const result = await inviteByEmail({
        flowId: input.flowId,
        flowName: flowRecord.name,
        email: input.email,
        role: input.role,
        invitedBy: {
          id: ctx.session.user.id,
          name: ctx.session.user.name || ctx.session.user.email,
        },
        grant: setFlowRole,
        mailer: resendInviteMailer,
      });

      if (result.kind === "granted") {
        return { success: true, userId: result.userId };
      }
      return { success: true, invited: true };
    }),

  /**
   * Invites for this flow that have no account behind them yet
   */
  pendingInvites: protectedProcedure
    .input(z.object({ flowId: z.string() }))
    .query(async ({ ctx, input }) => {
      await requireFlowAccess(input.flowId, ctx.session.user.id, "owner");
      return listPendingInvites(input.flowId);
    }),

  /**
   * Withdraw a pending invite
   */
  revokeInvite: protectedProcedure
    .input(z.object({ flowId: z.string(), email: z.string().email() }))
    .mutation(async ({ ctx, input }) => {
      await requireFlowAccess(input.flowId, ctx.session.user.id, "owner");
      await revokeInvite(input.flowId, input.email);
      return { success: true };
    }),
    /**
     * Update a collaborator's role
     */
    updateCollaboratorRole: protectedProcedure
      .input(z.object({ flowId: z.string(), userId: z.string(), role: z.enum(["viewer", "editor"]).default("viewer") }))
      .mutation(async ({ ctx, input }) => {
        await requireFlowAccess(input.flowId, ctx.session.user.id, "owner");

        const collaborator = await db.query.flowCollaborator.findFirst({
          where: and(eq(flowCollaborator.flowId, input.flowId), eq(flowCollaborator.userId, input.userId)),
        });
        
        if(!collaborator) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Collaborator not found" });
        }

        await setFlowRole(input.flowId, input.userId, input.role);

        return { success: true };
      }),
});
