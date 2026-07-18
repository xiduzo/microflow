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
