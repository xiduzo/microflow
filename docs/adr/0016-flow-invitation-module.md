# ADR-0016 — Flow Invitation lives in `@microflow/db`, with the mailer injected

- **Status:** accepted (2026-08-23)
- **Date:** 2026-08-23
- **Deciders:** sander

> **Decision:** the invite → accept → revoke lifecycle is one module at
> `packages/db/src/flow-invitation.ts`. It is placed there because api and auth
> both reach db and cannot reach each other. Email is an injected
> `InviteMailer` adapter, so the module depends on neither.

## Context

The lifecycle was spread across three packages with no module owning it:

- `flow.addCollaboratorByEmail` (`@microflow/api`) — looked the address up,
  inserted either a `flowCollaborator` or a `flowInvite`, and rendered and sent
  the email inline.
- The better-auth `user.create.after` hook (`@microflow/auth`) — converted
  pending invites on sign-up with a blind `insert`.
- `flow.addCollaborator` (`@microflow/api`) — a third grant path, with no
  duplicate check at all.

`flow_collaborator` had no unique index on `(flow_id, user_id)`, so the three
paths could produce duplicate grants — a user listed twice in the collaborator
panel, with whichever role won the render. Only one of the three checked for an
existing row, and the accept path — the one that silently hands out access —
had no test, because reaching it meant driving better-auth.

Pending invites were also invisible: recorded in a table, surfaced nowhere, and
withdrawable only in SQL.

## Decision

One module owning `grantAccess`, `inviteByEmail`, `acceptInvites`,
`listPendingInvites` and `revokeInvite`.

**Placement.** It belongs conceptually beside `flow-role.ts` and
`flow-access.ts` in `@microflow/api`, but `@microflow/auth` cannot import
`@microflow/api` — api already depends on auth for `sendEmail`, and the reverse
edge is a cycle. `@microflow/db` is the only package both callers already
reach. The alternative, a new `@microflow/flows` package for five functions,
buys nothing the placement does not.

**Injected mailer.** `inviteByEmail` takes an `InviteMailer`, so the module
needs neither `@microflow/auth` nor `@microflow/env`, and the wording lives
with the sender (`resendInviteMailer` in the api package) rather than with the
lifecycle. Two adapters make the seam real: Resend in production, a recording
function in tests. A rejected mailer is logged and swallowed — the grant has
already landed by then, and failing the mutation would report a denial that did
not happen.

**Idempotent grants.** A unique index on `(flow_id, user_id)` turns every grant
into an upsert. No path needs check-then-insert, and the accept hook cannot
duplicate a grant the invite path already made. Migration `0005` collapses
existing duplicates first, keeping the more permissive role.

## Consequences

- The accept path is testable, and tested, without better-auth.
- Three grant paths became one rule.
- Pending invites are listed and revocable in flow settings.
- `packages/db` now holds one domain module alongside the schema. If more
  follow, that is the signal to promote them into their own package rather than
  to let db accrete them.
