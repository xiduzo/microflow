import { z } from "zod";
import { eq, and, like, ne, inArray } from "drizzle-orm";
import { db } from "@microflow/db";
import { flow, flowCollaborator } from "@microflow/db/schema/flow";
import { user } from "@microflow/db/schema/auth";
import { userSettings } from "@microflow/db/schema/user-settings";
import { protectedProcedure, router } from "../index";
import {
  assertFlowRole,
  requireFlowAccess,
  resolveFlowRole,
  type FlowRole,
} from "./flow-access";
import { FlowDocument, yjsServer } from "@microflow/collab/server";
import {
  grantAccess,
  inviteByEmail,
  listPendingInvites,
  revokeInvite,
} from "@microflow/db/flow-invitation";
import { resendInviteMailer } from "./invite-mailer";

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

export const uid = () =>
  Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

/**
 * Push an access change onto any live Yjs connection the user holds.
 *
 * A socket resolves its Flow Role once, at connect time; without this a
 * removed collaborator keeps writing until they reconnect. Same-process only
 * — the tRPC router and the `/yjs/:flowId` endpoint are both mounted by
 * `apps/server`, so they share the `yjsServer` singleton.
 */
function syncLiveAccess(flowId: string, userId: string, role: FlowRole | null) {
  yjsServer.setAccess(flowId, userId, role === null ? "none" : role === "viewer" ? "read" : "write");
}

export function decodeFlowData(ydoc: Buffer | null) {
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

    const withPeople = {
      owner: { columns: { id: true, name: true } },
      collaborators: {
        columns: { role: true },
        with: { user: { columns: { id: true, name: true } } },
      },
    } as const;

    const flowColumns = {
      id: true,
      name: true,
      color: true,
      createdAt: true,
      updatedAt: true,
      ydoc: true,
    } as const;

    // Get flows where user is owner
    const ownedFlowsRaw = await db.query.flow.findMany({
      where: eq(flow.ownerId, userId),
      columns: flowColumns,
      with: withPeople,
    });

    // Get flows where user is collaborator
    const collaborations = await db.query.flowCollaborator.findMany({
      where: eq(flowCollaborator.userId, userId),
      with: {
        flow: { columns: flowColumns, with: withPeople },
      },
    });

    // Everyone with access, so the overview can show who a flow is shared
    // with. One settings query for every user across every flow.
    const involved = [...ownedFlowsRaw, ...collaborations.map((c) => c.flow)];
    const peopleIds = [
      ...new Set(
        involved.flatMap((f) => [f.owner.id, ...f.collaborators.map((c) => c.user.id)]),
      ),
    ];
    const settingsRows = peopleIds.length
      ? await db.query.userSettings.findMany({
          where: inArray(userSettings.userId, peopleIds),
          columns: { userId: true, collabColor: true, collabIcon: true },
        })
      : [];
    const settingsByUser = new Map(settingsRows.map((s) => [s.userId, s]));

    /** Owner + collaborators, minus the caller — that is what "shared with" means here. */
    function peopleOf(f: (typeof involved)[number]) {
      return [
        { ...f.owner, role: "owner" as const },
        ...f.collaborators.map((c) => ({ ...c.user, role: c.role })),
      ]
        .filter((person) => person.id !== userId)
        .map((person) => ({
          ...person,
          collabColor: settingsByUser.get(person.id)?.collabColor ?? "#4338ca",
          collabIcon: settingsByUser.get(person.id)?.collabIcon ?? "Cat",
        }));
    }

    const ownedFlows = ownedFlowsRaw.map((f) => {
      const { ydoc, owner, collaborators, ...rest } = f;
      return { ...rest, ...decodeFlowData(ydoc), people: peopleOf(f) };
    });

    const collaboratedFlows = collaborations.map((c) => {
      const { ydoc, owner, collaborators, ...rest } = c.flow;
      return {
        ...rest,
        ...decodeFlowData(ydoc),
        people: peopleOf(c.flow),
        role: c.role,
      };
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

      const role = assertFlowRole(
        resolveFlowRole(
          flowRecord,
          userId,
          flowRecord.collaborators.find((c) => c.user.id === userId)?.role as
            | FlowRole
            | undefined
        ),
        "viewer"
      );

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
        isOwner: role === "owner",
        role,
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
      await requireFlowAccess(input.id, ctx.session.user.id, "owner");

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
      const { flow: flowRecord } = await requireFlowAccess(
        input.id,
        ctx.session.user.id,
        "owner"
      );

      await db.delete(flow).where(eq(flow.id, input.id));

      // Discard the live room rather than let it flush back to a deleted row.
      yjsServer.dropRoom(input.id);

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
      const { flow: flowRecord } = await requireFlowAccess(
        input.id,
        ctx.session.user.id,
        "owner"
      );

      await db
        .update(flow)
        .set({
          publishedYdoc: flowRecord.ydoc,
          publishedAt: new Date(),
          description: input.description,
          updatedAt: flowRecord.updatedAt, // publishing is not an edit
        })
        .where(eq(flow.id, input.id));

      return { success: true };
    }),

  /**
   * Remove a flow from the community
   */
  unpublish: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { flow: flowRecord } = await requireFlowAccess(
        input.id,
        ctx.session.user.id,
        "owner"
      );

      await db
        .update(flow)
        .set({
          publishedYdoc: null,
          publishedAt: null,
          updatedAt: flowRecord.updatedAt,
        })
        .where(eq(flow.id, input.id));

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

      await grantAccess(input.flowId, input.userId, input.role);
      syncLiveAccess(input.flowId, input.userId, input.role);

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

      await db
        .delete(flowCollaborator)
        .where(
          and(
            eq(flowCollaborator.flowId, input.flowId),
            eq(flowCollaborator.userId, input.userId)
          )
        )

      syncLiveAccess(input.flowId, input.userId, null);

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
          throw new Error("Collaborator not found");
        }

        await db.update(flowCollaborator).set({ role: input.role }).where(eq(flowCollaborator.id, collaborator.id));

        syncLiveAccess(input.flowId, input.userId, input.role);

        return { success: true };
      }),
});
