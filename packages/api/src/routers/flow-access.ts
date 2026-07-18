import { and, eq } from "drizzle-orm";
import { db } from "@microflow/db";
import { flow, flowCollaborator } from "@microflow/db/schema/flow";
import { assertFlowRole, resolveFlowRole, type FlowRole } from "./flow-role";

export { assertFlowRole, resolveFlowRole, type FlowRole } from "./flow-role";

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
