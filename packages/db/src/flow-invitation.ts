import { and, eq, sql } from "drizzle-orm";
import { db, type Db } from "./index";
import { flowCollaborator, flowInvite } from "./schema/flow";
import { user } from "./schema/auth";

/**
 * The invitation lifecycle for a cloud flow: invite → accept → revoke.
 *
 * Lives in `@microflow/db` because it is the only package both callers can
 * reach: the flow router (`@microflow/api`) invites, and the better-auth
 * `user.create.after` hook (`@microflow/auth`) accepts, and api already
 * depends on auth. Email (`InviteMailer`) and the grant (`GrantRole`) are
 * injected as adapters so this module needs neither mail nor collab.
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

/**
 * Applies a grant when the invitee already has an account. Injected like the
 * mailer: the api layer passes its `setFlowRole` so the row write and the
 * live-access push stay paired — this package cannot reach the collab server.
 */
export type GrantRole = (
  flowId: string,
  userId: string,
  role: CollaboratorRole,
) => Promise<void>;

/** The inviter named their own address: a refusal, not a failure. */
export class CannotInviteSelf extends Error {
  constructor() {
    super("Cannot add yourself as a collaborator");
    this.name = "CannotInviteSelf";
  }
}

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
  await upsertGrants(db, userId, [{ flowId, role }]);
}

/**
 * The one grant write: each `(flow, user)` ends up with exactly one row,
 * carrying the role given here. `on` is the handle or an open transaction.
 * A flow may appear at most once in `grants`.
 */
async function upsertGrants(
  on: Pick<Db, "insert">,
  userId: string,
  grants: Array<{ flowId: string; role: CollaboratorRole }>,
): Promise<void> {
  await on
    .insert(flowCollaborator)
    .values(grants.map((grant) => ({ id: crypto.randomUUID(), userId, ...grant })))
    .onConflictDoUpdate({
      target: [flowCollaborator.flowId, flowCollaborator.userId],
      set: { role: sql`excluded.role` },
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
 * `CannotInviteSelf` when the inviter targets themselves — the one rule that
 * has no sensible fallback.
 */
export async function inviteByEmail(params: {
  flowId: string;
  flowName: string;
  email: string;
  role: CollaboratorRole;
  invitedBy: { id: string; name: string };
  grant: GrantRole;
  mailer: InviteMailer;
}): Promise<InviteResult> {
  const { flowId, flowName, email, role, invitedBy, grant, mailer } = params;

  const targetUser = await db.query.user.findFirst({ where: eq(user.email, email) });

  if (targetUser?.id === invitedBy.id) {
    throw new CannotInviteSelf();
  }

  const result: InviteResult = targetUser
    ? { kind: "granted", userId: targetUser.id }
    : { kind: "pending" };

  if (targetUser) {
    await grant(flowId, targetUser.id, role);
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
 *
 * All or nothing, in one transaction. The hook runs once per account, so
 * nothing retries an accept that stopped part-way: a failure rolls back and
 * leaves every invite pending, never some flows granted and the rest lost.
 * An invite revoked before the accept grants nothing, and a second accept
 * grants nothing more.
 *
 * The invites are consumed by the `DELETE … RETURNING` itself, and exactly
 * the rows it returns are granted, with the role each row holds when it is
 * deleted; nothing is read before the delete. That keeping it one statement
 * stops an invite revoked or re-issued *during* an accept from being granted
 * stale is the reason for the shape, not something the tests show: they run
 * on one database connection, which cannot interleave a second writer.
 */
export async function acceptInvites(email: string, userId: string): Promise<string[]> {
  return db.transaction(async (tx) => {
    const accepted = await tx
      .delete(flowInvite)
      .where(eq(flowInvite.email, email))
      .returning({ flowId: flowInvite.flowId, role: flowInvite.role });
    if (accepted.length === 0) return [];

    // One invite per flow per address (unique index), so no flow appears
    // twice here.
    await upsertGrants(tx, userId, accepted);

    return accepted.map((invite) => invite.flowId);
  });
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
