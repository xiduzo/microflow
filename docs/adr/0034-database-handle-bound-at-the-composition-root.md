# ADR-0034 — The database handle is bound at the composition root; the Flow library sits under the routers

- **Status:** accepted (2026-11-19)
- **Date:** 2026-11-19
- **Deciders:** sander

> **Decision:** `@microflow/db` exports a handle type (`Db`) and a `db` view that
> forwards to whatever the process's composition root bound with `bindDb`, once.
> The server binds a node-postgres pool; a test process binds an **in-process
> Postgres** (PGlite) with the real migrations applied. Above that handle, one
> module, the **Flow library** (`packages/api/src/routers/flow-library.ts`),
> owns the flow row and its two documents. Routers validate input, run the Flow
> Access check and make one call into it. The modules under the routers throw
> their own refusals, and one tRPC middleware gives each its code.

## Context

`packages/db/src/index.ts` was one line: `drizzle(env.DATABASE_URL, { schema })`,
evaluated at import. Three things followed from that.

**Importing the package needed the whole server environment**, and a process
with a `DATABASE_URL` in its environment queried whichever database that named.
There was no second adapter, so the only way to test anything above the handle
was `mock.module("@microflow/db", …)` with a hand-modelled fake of drizzle's
call shapes (`query.flow.findFirst`, `update().set().where()`), plus a fake of
the room server beside it. Those tests pinned the shape of the calls, not what
the SQL does. The rules that live in the database (the unique index that makes
a grant idempotent, the cascade on a deleted flow, ordering and paging of
Community flows) had no test that could fail.

**The flow rules were written in the routers, several times.** "A new flow from
a document" existed three times (create, import, fork). The fallback for a user
who never chose a collab colour and icon existed five times. The Community
rules were split between `flow.ts` and `community.ts`, which imported helpers
back out of the flow router, and `flow.get` carried its own eager-loaded access
query next to `requireFlowAccess`.

**A refusal was reported as a crash.** `requireFlowAccess` and the invite path
threw plain `Error`s, so tRPC answered a denied or missing flow with
`INTERNAL_SERVER_ERROR` (HTTP 500).

One gap in the invitation lifecycle ([ADR-0016](0016-flow-invitation-module.md))
came to light once it ran on real SQL: `acceptInvites` granted in a loop and
then deleted the invites, with no transaction, from a hook that runs once per
account.

## Decision

**D1 — `Db` is the seam, and it has two adapters.** `Db` is a drizzle handle
over the Microflow schema, whichever Postgres is behind it. `createDb(connectionString)`
is the production adapter (node-postgres). `packages/db/src/testing.ts`
(`@microflow/db/testing`) is the second: PGlite, Postgres compiled to
WebAssembly, running inside the test process with the migrations from
`packages/db/src/migrations` applied. Both run the same SQL against the same
indexes and constraints.

**D2 — The composition root binds the handle, once.** `bindDb(handle)` gives the
process its database. `apps/server/src/database.ts` calls
`bindDb(createDb(env.DATABASE_URL))`, and `apps/server/src/index.ts` imports it
first. A second `bindDb` throws: replacing the handle would strand the first
pool and move a module that is mid-query onto another database. `@microflow/db`
never reads the environment, so an unbound process fails on its first query
("No database is bound") instead of reaching a database nobody chose.

**D3 — `db` is a read-only view of the bound handle.** Modules keep importing
`db` and may hold it before the root runs; only using it needs a binding. The
view forwards every read to the bound handle (property reads with methods bound
to the handle, `in`, `instanceof`, key enumeration) and refuses every write.
`packages/db/src/index.test.ts` pins this.

**D4 — Tests bind by importing, and empty by calling.** Importing
`@microflow/db/testing` boots one engine, migrates it and binds it; under
`bun test` every test file shares the process and that binding. `useTestDb()`
empties every table, drops any trigger a test added to make a statement fail,
and returns the handle. No test replaces `@microflow/db` or
`@microflow/collab/server` with `mock.module`; the router tests run on the
in-process Postgres and the real room server.

**D5 — The Flow library owns the flow row and its documents.** A cloud flow is
a row plus two Yjs documents: `ydoc`, which collaborators edit, and
`publishedYdoc`, the snapshot the Community sees. `flow-library.ts` states the
rules for both once:

- a flow starts from content (nothing, imported nodes and edges, or a Community
  flow's snapshot), and all three build the document the same way
  (`createFlow`, `forkCommunityFlow`);
- readers take the live room's document ahead of the stored one (`openFlow`,
  `listFlows`, `publishFlow`);
- publishing freezes the current document into `publishedYdoc`; when no room is
  live the stored document is copied inside the `UPDATE`, so a save landing
  meanwhile is in the snapshot. A flow is a Community flow while `publishedAt`
  is set;
- popularity is the bookmark count, and fork counts derive from `forkedFromId`;
- people shown next to a flow carry their Collab identity (`collabIdentity`,
  falling back to `DEFAULT_COLLAB_IDENTITY`).

It does not decide who may call it. `flow.ts` and `community.ts` validate
input, run `requireFlowAccess` where a role is needed
([ADR-0022](0022-flow-role-transition-has-one-owner.md)), and make one call.
`flow.get` goes through `requireFlowAccess` like every other procedure.
`profile.ts` takes `collabIdentity` from the library, so a profile and a flow
show the same person the same way.

**D6 — Refusals are typed where they are decided and coded in one place.** The
modules under the routers know nothing of tRPC: they throw `FlowAccessDenied`,
`FlowLibraryNotFound` and `CannotInviteSelf`. One middleware on the base
procedure (`packages/api/src/index.ts`, `codeOf`) maps them to `FORBIDDEN` or
`NOT_FOUND`, `NOT_FOUND`, and `BAD_REQUEST`, keeping the module's message.
Anything else stays `INTERNAL_SERVER_ERROR`. The websocket gate reads the same
`FlowAccessDenied` to tell a decision from a failure to decide.

**D7 — Accepting invites is one transaction.** `acceptInvites` consumes the
pending invites with `DELETE … RETURNING` and grants exactly the rows it got
back, through the same upsert `grantAccess` uses; nothing is read before the
delete. A failure rolls back and leaves every invite pending. Keeping the
consume to one statement is meant to stop an invite revoked or re-issued
during an accept from being granted stale; no test shows that, because the
tests run on one connection, which cannot interleave a second writer.

## Considered options

- **Pass a `Db` into every function.** The honest form of injection, but
  better-auth's adapter, the room store and every router would have to thread
  it, for a value that is one per process. Binding once at the root gives the
  same two adapters at the cost of a module-level slot.
- **A Postgres container for tests.** Real SQL too, but it needs Docker on
  every contributor's machine and a service in CI, and each run pays its
  start-up.
- **Keep faking drizzle's call shapes.** No dependency, and no test that can
  fail on what the database does.

## Consequences

- `bun test` needs no Docker, network or environment for the database-backed
  packages; `.github/workflows/typescript.yml` runs it with no Postgres
  service. Docker is for running the server locally (`bun run db:start`).
- Tests cover what SQL decides: one row after a double grant, one bookmark per
  user and flow, popularity order and paging, a fork that keeps `forkedFromId`.
- PGlite is a single connection. A query made on `db` from inside a
  `db.transaction()` callback waits for that transaction forever; inside a
  transaction, code uses the `tx` it is handed. Concurrency between pooled
  connections is not exercised by these tests.
- Booting and migrating the engine costs one to several seconds per test
  process, paid at import.
- The binding is process-wide state. Test files share it, so each test starts
  from `useTestDb()`, and a module that needs a different database in the same
  process cannot have one.
- Two refusals are raised in a router as a `TRPCError`: "Collaborator not
  found" in `flow.updateCollaboratorRole` and "User not found" in `profile.get`.
  `flow.searchUsers` and the profile procedures query `db` directly. They are
  not flow-row rules, and nothing forces them through the library.
- The one fake left in the router tests is the invite mailer, which reaches
  Resend and the server environment at import.

## What this does NOT decide

- Who may do what on a flow: that stays with the Flow Access seam and
  `setFlowRole` ([ADR-0022](0022-flow-role-transition-has-one-owner.md)).
- Where the room's document is stored and how it is saved
  ([ADR-0015](0015-room-connection-owns-access.md), `RoomStore`).
- Paging: the Community listings are offset-based until they need keyset paging.
- Whether the Flow library becomes its own package. It lives in `@microflow/api`
  because it needs the room server and nothing outside the routers calls it.

## References

- `packages/db/src/index.ts` — `Db`, `createDb`, `bindDb`, `db`.
- `packages/db/src/testing.ts` — the in-process Postgres, `useTestDb`.
- `apps/server/src/database.ts` — the server's binding.
- `packages/api/src/routers/flow-library.ts` — the Flow library.
- `packages/api/src/index.ts` — `codeOf` and the refusal middleware.
- `packages/db/src/flow-invitation.ts` — `acceptInvites`, `CannotInviteSelf`.
- `packages/api/src/routers/flow-library.test.ts`, `flow-procedures.test.ts`,
  `flow-access.test.ts`, `packages/db/src/flow-invitation.test.ts` — the tests
  on real SQL.
- `CONTEXT.md` § Db handle, Flow library, Community flow, Collab identity.
