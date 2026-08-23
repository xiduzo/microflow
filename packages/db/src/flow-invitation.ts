import { and, eq } from "drizzle-orm";
import { db } from "./index";
import { flowCollaborator, flowInvite } from "./schema/flow";
import { user } from "./schema/auth";

/**
 * The invitation lifecycle for a cloud flow: invite → accept → revoke.
 *
 * Lives in `@microflow/db` because it is the only package both callers can
 * reach: the flow router (`@microflow/api`) invites, and the better-auth
 * `user.create.after` hook (`@microflow/auth`) accepts, and api already
 * depends on auth. Email is injected as an adapter (`InviteMailer`) so this
 * module needs neither.
 */

// ============================================================================
// Types
// ============================================================================

/** The roles an invitation can grant. Owner is not grantable. */
export type CollaboratorRole = "viewer" | "editor";

export type InviteNotice = {
  to: string;
  flowId: string;
  flowName: string;
  role: CollaboratorRole;
  /** Display name of the person doing the inviting. */
  invitedBy: string;
  /**
   * `"granted"` — the recipient has an account and now has access.
   * `"pending"` — no account yet; they get access when they sign up.
   */
  kind: "granted" | "pending";
};

/**
 * Sends the invite notification. Two adapters: Resend in production, a
 * recording function in tests. Rejections are swallowed by the caller — the
 * access grant has already succeeded by the time this runs.
 */
export type InviteMailer = (notice: InviteNotice) => Promise<void>;

export type InviteResult =
  | { kind: "granted"; userId: string }
  | { kind: "pending" };

// ============================================================================
// Grants
// ============================================================================

/**
 * Give `userId` `role` on `flowId`, idempotently.
 *
 * The unique index on `(flow_id, user_id)` is what makes this safe to call
 * from both the invite path and the sign-up hook without either checking
 * first — a second grant updates the row instead of duplicating the
 * collaborator.
 */
export async function grantAccess(
  flowId: string,
  userId: string,
  role: CollaboratorRole,
): Promise<void> {
  await db
    .insert(flowCollaborator)
    .values({ id: crypto.randomUUID(), flowId, userId, role })
    .onConflictDoUpdate({
      target: [flowCollaborator.flowId, flowCollaborator.userId],
      set: { role },
    });
}

// ============================================================================
// Invite
// ============================================================================

/**
 * Invite `email` to `flowId`.
 *
 * Grants immediately when the address already has an account; otherwise
 * records a pending invite that `acceptInvites` converts on sign-up. Throws
 * when the inviter targets themselves — the one rule that has no sensible
 * fallback.
 */
export async function inviteByEmail(params: {
  flowId: string;
  flowName: string;
  email: string;
  role: CollaboratorRole;
  invitedBy: { id: string; name: string };
  mailer: InviteMailer;
}): Promise<InviteResult> {
  const { flowId, flowName, email, role, invitedBy, mailer } = params;

  const targetUser = await db.query.user.findFirst({ where: eq(user.email, email) });

  if (targetUser?.id === invitedBy.id) {
    throw new Error("Cannot add yourself as a collaborator");
  }

  const result: InviteResult = targetUser
    ? { kind: "granted", userId: targetUser.id }
    : { kind: "pending" };

  if (targetUser) {
    await grantAccess(flowId, targetUser.id, role);
  } else {
    await db
      .insert(flowInvite)
      .values({ id: crypto.randomUUID(), flowId, email, role, invitedBy: invitedBy.id })
      .onConflictDoUpdate({
        target: [flowInvite.flowId, flowInvite.email],
        set: { role, invitedBy: invitedBy.id },
      });
  }

  // The grant has landed; a failed notification must not undo it.
  try {
    await mailer({
      to: email,
      flowId,
      flowName,
      role,
      invitedBy: invitedBy.name,
      kind: result.kind,
    });
  } catch (error) {
    console.error("[flow-invitation] notification failed:", error);
  }

  return result;
}

// ============================================================================
// Accept
// ============================================================================

/**
 * Convert every pending invite for `email` into a collaborator grant.
 * Called from the sign-up hook; returns the flow ids granted.
 */
export async function acceptInvites(email: string, userId: string): Promise<string[]> {
  const invites = await db.query.flowInvite.findMany({
    where: eq(flowInvite.email, email),
  });
  if (invites.length === 0) return [];

  for (const invite of invites) {
    await grantAccess(invite.flowId, userId, invite.role);
  }
  await db.delete(flowInvite).where(eq(flowInvite.email, email));

  return invites.map((invite) => invite.flowId);
}

// ============================================================================
// Pending invites
// ============================================================================

/** Invites for `flowId` that nobody has signed up against yet. */
export async function listPendingInvites(flowId: string) {
  const invites = await db.query.flowInvite.findMany({
    where: eq(flowInvite.flowId, flowId),
  });
  return invites.map((invite) => ({
    id: invite.id,
    email: invite.email,
    role: invite.role,
    createdAt: invite.createdAt,
  }));
}

/** Withdraw a pending invite. A no-op if it was already accepted. */
export async function revokeInvite(flowId: string, email: string): Promise<void> {
  await db
    .delete(flowInvite)
    .where(and(eq(flowInvite.flowId, flowId), eq(flowInvite.email, email)));
}
