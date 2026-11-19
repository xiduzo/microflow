# ADR-0032 — A node's handles are a function of its settings; a handle that vanishes takes its edges

- **Status:** accepted (2026-11-19)
- **Date:** 2026-11-19
- **Deciders:** sander

> **Decision:** the handles a node offers for connection are one function of its
> type and its settings, the **Live Handle Set** (`apps/web/src/nodes/handles.ts`).
> Each node states that function once, as its **Handle Rule**, and every reader
> asks the same module: the canvas, the connection check, Ask AI, the template
> guard and the flow file. When a settings change takes a handle off a node, the
> **session** removes the edges at it. It reacts to the handle vanishing, never
> to an edge being present, and it is handed the handle sets at app start
> because `session/` does not import `nodes/`. A removal whose cause is
> reverted is reverted with it.

## Context

A node had two answers to "which handles do you have?". The wire interface
(`COMPONENT_PORTS` / `COMPONENT_EMITS`, [ADR-0007](0007-node-wire-interface-emit-contract.md))
lists every Port and Emit the Rust component declares, for any settings. What a
node actually offered lived in its React file: a static node passed
`instance="Led"` to `NodeHandles`, and a node whose handles follow its settings
(Mqtt by `direction`, Function and Llm by the `{{variable}}`s in their text,
Music by its records, Servo by its type) drew some or all of its own `Handle`s.

Everything that was not React read the wire interface. Ask AI's `connect`, its
node catalogue and the template guard all checked `COMPONENT_PORTS` /
`COMPONENT_EMITS`, so a model could wire `trigger` on a subscribing Mqtt node:
an edge in the document with nothing on the canvas to show or delete it.

Removing the edges of a handle that went away was the mounted node's job. Four
node components (Function, Llm, Music, Servo) called a `useDeleteHandles` hook
from an effect; Mqtt and Midi did not. An edit that changed a node without that
component being mounted removed nothing: Ask AI, a flow tool called over MCP,
an undo, or a collaborator's change arriving while the canvas was not open.

Two more forces shaped the rule. A room holds several Editors, and they can run
different builds, so two clients can disagree about a node's handles. And
stored content is not always clean: a saved flow or a template may hold an edge
at a handle its node does not offer, and opening it must not edit it.

## Decision

**D1 — One answer: the Live Handle Set.** `liveHandles(type, data)` returns
`{ ports, emits }` for a node of `type` configured with `data`. It is total: it
answers for any `data`, never throws, and a setting that is missing or unusable
reads as the node's default. Every id is a non-empty string, unique per side;
a Port and an Emit may share an id (`value`) and are different handles.
`nodeHandles(node)` is the same for a node as found in a flow, and `null` when
this build does not know the type. The live set is not the wire interface: it
is the part of it the node offers as configured, plus its **open ports**, which
the settings themselves name and no generated list can hold.

**D2 — Each node states its handles once, as a Handle Rule.**
`nodes/<node>/<node>.handles.ts` exports `handles = defineHandles<"T", Data>(layout, …)`
(`nodes/_base/handle-rule.ts`). `layout(settings)` returns the Ports and Emits in
render order, with how each is drawn. A Port id is typed `PortOf<T>` and an Emit
id `EmitOf<T>`, so a renamed Rust handle stops the file compiling; an open port
says `open: true`. `variants` indexes the settings that select each distinct
handle set, for a reader that has no node yet. `nodes/handle-rules.ts` holds one
line per catalog entry and `satisfies` a record over `ComponentType`, so a new
entry does not compile without a rule. A Variant shares its parent's rule.

**D3 — One renderer, one check.** `<NodeHandles />`
(`nodes/_base/node-handles.tsx`) renders the layout for the node it is placed in
and is the only place handles are rendered. Its override maps carry only what
depends on the host (`HandleOverride`). Every other reader goes through
`nodes/handles.ts`: the canvas refuses a dragged connection with `checkEdge`
(`isValidHandleConnection`); Ask AI's `connect` makes the same check against
the flow with the turn's staged edits applied; the catalogue prompt lists
handles per setting value from `handleVariants`; the template guard and the
flow file decode use `checkEdge` / `checkEdgeEnds`. An Ask AI `update_node_data`
that takes a handle away removes the edges at it as part of the same edit, one
named line per edge, so an approval lists what it will remove.

**D4 — The session prunes, and the trigger is the document.**
`startHandlePruning(doc, handleSets, liveness)` (`session/handle-pruning.ts`)
watches node `data` and, when a node's handle set loses a handle, removes the
edges at that handle on that side. `pruneWhileWritable` (`session/flow-session.ts`)
runs it beside the dangling-edge prune for as long as the session may write, so
every Editor prunes and a Viewer never does. No canvas is involved. The session
knows documents, not nodes: `wireApp()` (`apps/web/src/app-wiring.ts`, called
first thing in `main.tsx`) hands it `nodeHandles` through `provideHandleSets`. A
writable session that starts without them reports once through `reportError`
([ADR-0029](0029-one-failure-surface.md)) and repairs dangling edges only.

**D5 — It reacts to a handle vanishing, never to an edge being there.** An edge
is removed only when this client sees its handle go: offered before a change,
not offered after it. Starting does not sweep the document, and a handle whose
node has an unknown type is never pruned. Only an edit of an existing node is a
settings change. A node written whole is new content, whatever id it reuses:
`setFlowData` (a template, an import or a fork landing in the local flow), the
stored document loading, the
shape upgrade, the undo or redo of these, and a change of `type`. A change that
did not originate here, in a session that has never been in sync with its room,
is content too. This client's own changes always count.

**D6 — A catch-up is noted, then acted on.** A session that has been live and
drops out sees its peers' edits arrive in pieces when it reconnects. It records
the handles that vanish and removes the edges at them in one transaction when
it is live again. A handle that came back by then keeps its edges, and the
record is cleared there and then.

**D7 — A local edit and its prune are one undo step.** After the user's own
edit (origin `"local"`) the removal is written as `"local"` right behind it, so
the `UndoManager` merges both and undo restores the edges with the setting.
Every other removal uses `PRUNE_ORIGIN`, outside the undo history.

**D8 — A prune is reverted with its cause.** A removal made while live is
remembered with the transition that justified it: the node, the handle that
vanished, whether the change was this client's own (an edit, an undo or a
redo), and the setting entries the change wrote. The record is spent the first
time that handle is offered again, whatever brought it back. The edge returns
then, under its own id, with `PRUNE_ORIGIN` and outside the undo history, only
when the change that brought the handle back reverts the transition:

- this client's undo or redo of a transition that was its own (an undo that
  pruned a peer's edge, then the redo; or the other way round); or
- a value of a setting the transition wrote, written without knowing of it (it
  displaced the same entry the transition displaced), winning the conflict:
  two Editors set one setting at once and the value that keeps the handle
  wins, at once or in a later catch-up.

A handle given back by a new change (a value set back by hand, here or by a
peer) restores nothing. Before a restore the session checks that no edge with
that id or with the same ends is in the document, that both nodes exist, and
that each end is at a handle its node offers now (an end whose node's handles
are unknown is taken as it was). A record is also spent when its edge, or one
with the same ends, is in the document again, and when either node is deleted
or written whole, so an edge deleted on purpose after it came back stays
deleted. Every client that pruned the edge may restore it; the restores carry
the same id and content and converge on one edge. A restore adds an edge and
pruning never reacts to an edge being added, so two clients cannot prune and
restore in turn.

For the user's own edit, D7 already does this: the undo brings the edge back
with the setting, and the edge being back spends the record.

## Considered options

- **Keep pruning in the mounted node.** It misses every edit made without a
  canvas, which is where the stale edges came from.
- **Sweep: remove any edge that is not at a live handle.** Simple and
  convergent, but an older build in a room would keep deleting a newer build's
  edges, and loading a saved flow would edit it. The runtime also honours an
  edge at a handle the component declares and the node does not offer.
- **Let `session/` import `nodes/handles.ts`.** It reverses the one dependency
  direction the session has; the session would load the node library.
- **Pass the handle sets to each session factory.** Sessions are shared through
  the registry, so every maker of a session would have to agree. One app-wide
  hand-over cannot disagree with itself.
- **Restore an edge whenever its handle comes back.** A value set back by hand
  is a new decision made on a canvas that does not show the edge; restoring
  would add wiring nobody asked for, and a peer's later edit would do the same.
- **Keep no record.** An undo that pruned a peer's edge, followed by its redo,
  or a concurrent edit that loses, would then delete wiring for good although
  the setting ends where it started.

## Consequences

- A setting changed by a panel, Ask AI, an MCP flow tool, undo or a collaborator
  prunes the same way. Adding a node costs one `<node>.handles.ts` and one line
  in `nodes/handle-rules.ts`; the node's component renders `<NodeHandles />`.
- A Rust Port or Emit that no rule offers fails `nodes/handles.test.ts` until a
  rule offers it. The only declared handles left off are the ones
  [ADR-0044](0044-declared-drawn-and-honoured-handles-are-one-set.md) lists.
- **Accepted: an invisible edge can remain** when whoever wired it never sees
  the handle go as an edit: a tab on a stale seed wires a handle before its
  first sync, an undo brings back an edge at a handle a peer removed in between,
  or the wirer runs a build that does not prune. A stale edge costs little; a
  rule that keeps deleting wiring a peer considers valid costs the peer work.
- **Under version skew the stricter build removes an edge once.** The removal
  follows the handle sets of the client that makes it, with the prune origin,
  so the other peer's undo restores its setting and not the edge. An edge wired
  there afterwards is left alone by everyone. A restore (D8) follows the
  handle sets of the client that makes it too: it puts back only an edge its
  own build offers, and nothing is removed because of a restore.
- **Some reverts are not recognised**, and the edge stays pruned, as it would
  with no record: a concurrent value from a writer that was further behind
  (it displaced an older entry than the transition did); a value that wins
  over a transition that deleted the setting rather than wrote it; a removal
  made at the end of a catch-up, which is not remembered (the client whose
  edit lost restores it, if it prunes); and a revert after the session forgot
  its records, which happens on a reload, on losing or regaining write access,
  and in a new session.
- **A deliberate delete racing the prune can come back.** A peer that deletes
  an edge by hand while a change prunes it, before either has seen the other,
  deletes the same entry, and nobody can tell the two apart afterwards. If the
  change is then reverted, the edge is restored.
- **D8 reads Yjs internals.** Telling a concurrent write from a new one uses
  the entry a setting holds (`Y.Map._map`), the entry it displaced
  (`Item.origin`) and `Y.compareIDs`. A Yjs upgrade that changes those breaks
  the concurrent case; `session/handle-pruning.test.ts` covers it.
- A node still in the pre-[ADR-0019](0019-nested-node-fields-for-concurrent-edits.md)
  shape is written whole by its first edit, so that edit is not pruned.
- `variants` is a hand-kept index of `layout`; the test holds the two together.
- Ask AI's staged view covers one turn. A setting staged in a later turn that
  removes the handle of a connection staged in an earlier, unanswered turn gets
  no "removed connection" line; the session removes that edge on approval.
- `provideHandleSets` is app-wide module state. `app-wiring.test.ts` checks that
  `main.tsx` calls `wireApp()` before anything can make a session.

## What this does NOT decide

- **Which declared handles a node offers.** That every declared handle is
  offered, but for a short list of exceptions, is
  [ADR-0044](0044-declared-drawn-and-honoured-handles-are-one-set.md).
- **What happens to an edge already at a handle that is not offered.** Nothing
  sweeps stored flows. How a flow file treats one is [ADR-0041](0041-flow-file-is-a-load-boundary.md).
- **The wire interface** ([ADR-0007](0007-node-wire-interface-emit-contract.md))
  and the runtime's routing. The runtime routes by `ports()` / `emits()` and
  knows nothing of the live set, which is an editor concept.
- **The dangling-edge prune** (a node delete racing a new edge), recorded in
  [ADR-0004](0004-react-flow-bridge.md)'s amendments.

## References

- `apps/web/src/nodes/handles.ts` — `liveHandles`, `nodeHandles`, `handleVariants`, `checkEdge`, `checkEdgeEnds`, `EdgeProblem`.
- `apps/web/src/nodes/_base/handle-rule.ts` — `HandleRule`, `defineHandles`, `PortSpec`, `EmitSpec`, `openPorts`.
- `apps/web/src/nodes/handle-rules.ts` — the rule of every catalog entry.
- `apps/web/src/nodes/_base/node-handles.tsx`, `_base/connection-validity.ts` — the renderer and the canvas check.
- `apps/web/src/session/handle-pruning.ts`, `session/flow-session.ts` — `startHandlePruning`, `pruneWhileWritable`, `provideHandleSets`.
- `apps/web/src/app-wiring.ts`, `apps/web/src/app-wiring.test.ts` — `wireApp`.
- `apps/web/src/ai/flow-tools.ts`, `ai/catalog-prompt.ts` — `connect`, `update_node_data`, the staged flow, the catalogue.
- Tests: `nodes/handles.test.ts`, `nodes/handle-pruning.test.ts`, `session/handle-pruning.test.ts`, `flows/templates/index.test.ts`.
- [ADR-0027](0027-web-app-domain-verticals.md) — the `may-import` rule that keeps `session/` from importing `nodes/`.
- `CONTEXT.md` § Live Handle Set, Handle Rule, Open port, Handle pruning.
