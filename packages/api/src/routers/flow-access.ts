import { and, eq } from "drizzle-orm";
import { db } from "@microflow/db";
import { flow, flowCollaborator } from "@microflow/db/schema/flow";
import { grantAccess, type CollaboratorRole } from "@microflow/db/flow-invitation";
import { yjsServer, type Access } from "@microflow/collab/server";

export type FlowRole = "viewer" | "editor" | "owner";

const RANK: Record<FlowRole, number> = { viewer: 0, editor: 1, owner: 2 };

/**
 * Resolve the role a user has on a flow. The single source of truth for
 * "who counts as what" — every procedure routes through this, whether it
 * fetched the flow itself (get) or via requireFlowAccess.
 */
export function resolveFlowRole(
  flowRecord: { ownerId: string },
  userId: string,
  collaboratorRole: FlowRole | null | undefined
): FlowRole | null {
  if (flowRecord.ownerId === userId) return "owner";
  return collaboratorRole ?? null;
}

/** Throw unless `role` is at least `minRole`. Returns the role for convenience. */
export function assertFlowRole(
  role: FlowRole | null,
  minRole: FlowRole
): FlowRole {
  if (!role || RANK[role] < RANK[minRole]) {
    throw new Error("Access denied");
  }
  return role;
}

/** Map a collaborator role onto the live room's access vocabulary. */
export function roleToAccess(role: CollaboratorRole | null): Access {
  if (role === null) return "none";
  return role === "viewer" ? "read" : "write";
}

/**
 * The one owner of a Flow-Role transition: writes the collaborator row
 * (`null` = revoke) AND pushes the change onto any live Yjs connection the
 * user holds. Never do one without the other — a socket resolves its role
 * once, at connect time, so a bare row write leaves the old access live
 * until reconnect.
 *
 * Same-process only — the tRPC router and the `/yjs/:flowId` endpoint are
 * both mounted by `apps/server`, so they share the `yjsServer` singleton.
 */
export async function setFlowRole(
  flowId: string,
  userId: string,
  role: CollaboratorRole | null
): Promise<void> {
  if (role === null) {
    await db
      .delete(flowCollaborator)
      .where(
        and(
          eq(flowCollaborator.flowId, flowId),
          eq(flowCollaborator.userId, userId)
        )
      );
  } else {
    await grantAccess(flowId, userId, role);
  }
  yjsServer.setAccess(flowId, userId, roleToAccess(role));
}

/**
 * Fetch a flow and enforce that `userId` has at least `minRole` on it.
 * Throws "Flow not found" / "Access denied"; returns the row + resolved role.
 */
export async function requireFlowAccess(
  flowId: string,
  userId: string,
  minRole: FlowRole
) {
  const flowRecord = await db.query.flow.findFirst({
    where: eq(flow.id, flowId),
  });

  if (!flowRecord) {
    throw new Error("Flow not found");
  }

  let collaboratorRole: FlowRole | undefined;
  if (flowRecord.ownerId !== userId) {
    const collaborator = await db.query.flowCollaborator.findFirst({
      where: and(
        eq(flowCollaborator.flowId, flowId),
        eq(flowCollaborator.userId, userId)
      ),
    });
    collaboratorRole = collaborator?.role as FlowRole | undefined;
  }

  const role = assertFlowRole(
    resolveFlowRole(flowRecord, userId, collaboratorRole),
    minRole
  );

  return { flow: flowRecord, role };
}
