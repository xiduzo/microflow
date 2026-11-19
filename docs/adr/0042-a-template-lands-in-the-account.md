# ADR-0042 — A signed-in user's template becomes a new flow in their account

- **Status:** accepted (2026-11-19)
- **Date:** 2026-11-19
- **Deciders:** sander
- **Amends:** [ADR-0041](0041-flow-file-is-a-load-boundary.md) D5

> **Decision:** choosing a template lands it the way an import and a Community
> fork land. Signed in, it becomes a **new** flow in the user's account, named
> after the template (`flow.createFromImport`), and the editor opens it. Each
> choice makes another new flow. When the account cannot create it, the user
> is told and nothing else changes; the local flow is never used instead.
> Signed out, the template replaces the local flow. `openTemplate`
> (`apps/web/src/flows/templates/open-template.ts`) is the one place this is
> decided.

## Context

[ADR-0041](0041-flow-file-is-a-load-boundary.md) gave every flow that arrives
as content one landing rule, `openFlowFromContent`. An import and a Community
fork land in the account when somebody is signed in. A template was the one
exception: the templates page passed `"local"`, so a signed-in user's template
replaced the local flow, a flow they could not see in their list, share or open
on another device. The local flow may also hold work of its own, which a
template then overwrote.

## Decision

**D1 — Signed in, a template is a new flow in the account.** `openTemplate`
hands `openFlowFromContent` an `account` creator that calls
`flow.createFromImport` with the template's nodes and edges and the template's
name (`useOpenTemplate` adds a random flow colour). The flow it created becomes
the active flow and the editor opens it. The user is told "Flow created" with
the flow's name, and the list of flows is refreshed.

**D2 — Each choice is a new flow.** Choosing a template again creates another
flow. A flow an earlier choice made stays as its user left it; nothing reopens
or overwrites it. While one template is being opened, a further choice opens
nothing (`useOpenTemplate`), so a double click does not create two flows.

**D3 — A failure to create is an error, with no fallback.** When the account
does not create the flow, or cannot be reached, the user sees "Couldn't create
a flow from the template" and the active flow stays as it was. The content
does not land in the local flow instead. That is the rule an import and a
Community fork follow. An account that refuses is an answer, not a fault of the
app, so it is not sent to `reportError`; a local flow that cannot be saved is,
and the user sees "Couldn't load the template".

**D4 — Signed out, a template replaces the local flow.** There is no account,
and the local flow is the one flow on this device.

**D5 — `FlowDestination` has no local variant.** `FlowDestination` is
`{ account }`. Signed in, every caller lands in the account; signed out, every
caller lands in the local flow. Whether somebody is signed in is the landing's
question (`FlowLanding.signedIn`), never the caller's.

## Considered options

- **Keep templates local.** It overwrites the local flow, which may hold work,
  and leaves a signed-in user with a flow outside their account.
- **Reopen the flow an earlier choice of the same template made.** The user
  would get back a flow they changed, not the template. Starting again is what
  choosing a template means.
- **Fall back to the local flow when the account fails.** The user would think
  the flow is in their account, and the local flow's own work would be lost.

## Consequences

- A signed-in user's flow list grows by one flow each time they choose a
  template. Deleting the ones they do not want is theirs to do.
- A template counts as an import on the server: `flow.createFromImport` takes
  any arrays, and the server trusts the client's content, as for a file
  ([ADR-0041](0041-flow-file-is-a-load-boundary.md)).
- Starting from a template needs the server when signed in. Offline, signed
  in, a template cannot be opened.

## What this does NOT decide

- What a template holds, or how templates stay aligned with the tutorials.
- Where a signed-out user's local flow goes when they sign in.

## References

- `apps/web/src/flows/templates/open-template.ts` — `openTemplate`, `TemplatePorts`, `TemplateReport`.
- `apps/web/src/flows/templates/use-open-template.ts` — `useOpenTemplate`.
- `apps/web/src/flows/open-flow.ts`, `use-open-flow.ts` — `openFlowFromContent`, `FlowDestination`, `FlowLanding`.
- `apps/web/src/routes/templates.tsx` — the templates page.
- `packages/api/src/routers/flow.ts` — `flow.createFromImport`.
- Tests: `flows/templates/open-template.test.ts`.
- `CONTEXT.md` § Open flow from content.
