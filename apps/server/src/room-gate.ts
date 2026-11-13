// The protocol module alone: the `/server` entry loads the database client.
import {
  CLOSE_FLOW_GONE,
  CLOSE_FORBIDDEN,
  CLOSE_INTERNAL_ERROR,
  CLOSE_POLICY_VIOLATION,
} from "@microflow/collab/protocol";

export type RoomGateDecision =
  | { ok: true; userId: string; canWrite: boolean }
  | { ok: false; code: number; reason: string };

export type RoomGateDeps = {
  /** The caller's session, or `null` when there is none. May throw on infra failure. */
  getSession(): Promise<{ user: { id: string } } | null>;
  /** Resolve the user's role on the flow; throws on denial or on infra failure. */
  requireAccess(userId: string): Promise<{ role: string }>;
  /**
   * Which errors from `requireAccess` are *decisions*. Anything this returns
   * `null` for is a failure to decide.
   */
  classifyDenial(error: unknown): "not-found" | "denied" | null;
};

/**
 * The websocket auth gate's decision, as a close code the client can act on.
 *
 * The distinction that matters is decision vs failure-to-decide. A denial is
 * terminal (`CLOSE_FORBIDDEN`, or `CLOSE_FLOW_GONE` for a missing flow); a
 * database timeout or unready pool while checking is `CLOSE_INTERNAL_ERROR`,
 * which clients retry. The gate used to close 1008 "Forbidden" for both, so a
 * deploy hiccup put every connecting client into "access lost".
 */
export async function decideRoomAccess(deps: RoomGateDeps): Promise<RoomGateDecision> {
  let session: Awaited<ReturnType<RoomGateDeps["getSession"]>>;
  try {
    session = await deps.getSession();
  } catch (error) {
    console.error("[YJS] Session check failed; client will retry", error);
    return { ok: false, code: CLOSE_INTERNAL_ERROR, reason: "Session check failed" };
  }
  if (!session) return { ok: false, code: CLOSE_POLICY_VIOLATION, reason: "Unauthorized" };

  try {
    // Authenticated is not authorized: check this user against THIS flow,
    // through the same owner/collaborator model the tRPC procedures use.
    // Viewers may connect, but read-only.
    const { role } = await deps.requireAccess(session.user.id);
    return { ok: true, userId: session.user.id, canWrite: role !== "viewer" };
  } catch (error) {
    switch (deps.classifyDenial(error)) {
      case "not-found":
        return { ok: false, code: CLOSE_FLOW_GONE, reason: "Flow not found" };
      case "denied":
        return { ok: false, code: CLOSE_FORBIDDEN, reason: "Forbidden" };
      default:
        console.error("[YJS] Access check failed; client will retry", error);
        return { ok: false, code: CLOSE_INTERNAL_ERROR, reason: "Access check failed" };
    }
  }
}
