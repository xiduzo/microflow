# ADR-0041 — A flow file is a load boundary, read the way a stored flow is

- **Status:** accepted (2026-11-19); amended by [ADR-0042](0042-a-template-lands-in-the-account.md)
- **Date:** 2026-11-19
- **Deciders:** sander

> **Decision:** the exported JSON of a flow is a versioned format, the **Flow
> File**, with one codec (`apps/web/src/flows/flow-file.ts`). `decodeFlowFile`
> is the load boundary for a file: nothing past it sees unchecked content. A
> file with a defect is read as a stored flow with the same defect is opened,
> and every difference from the file is reported as a **Flow File Notice**. A
> file is refused only when it cannot be a flow. A file and the document read
> an edge through one function, `decodeEdge`. Decoded content lands through
> one rule, `openFlowFromContent`, shared with templates and Community forks.

## Context

An export was `JSON.stringify` of the document's nodes and edges, and an
import was `JSON.parse(text) as FlowExportData` followed by a check that
`data.nodes` and `data.edges` were truthy. `use-flow-import-export.ts` held two
such readers. Whatever else the file held went straight into a `FlowDocument`
or to `flow.createFromImport`, whose input is `z.array(z.any())`. The file's
`version` field carried the flow's own version, not the format's, so no reader
could tell an old file from a new one. Nothing bounded the size of a file that
is parsed on the main thread.

A file is the one way content reaches a document without having been written
by this build: it can come from an older release, a newer one, a hand edit or
another program. [ADR-0019](0019-nested-node-fields-for-concurrent-edits.md)
settled where a stored document's shape is brought forward: at the load
boundary, never in the read path. A file had no boundary at all.

Two answers were open for a file with a defect: reject it, or repair it. A
stored flow with the same defect already has an answer. The document keeps a
node of an unknown type and the runtime reports it as not running. It keeps a
setting stored under an old label, and the app opens that flow. The session
keeps an edge at a handle nothing declares ([ADR-0032](0032-live-handle-set-and-handle-pruning.md)). An import that rejected
or rewrote what the app accepts from its own store would make a flow's
behaviour depend on how it arrived.

Landing was also written three times: the templates page, the Community fork
and the import each saved the content, set the active flow and navigated,
with their own handling of a failure halfway.

## Decision

**D1 — One codec, with a format version.** `encodeFlowFile` writes `{ meta,
data, version, exportedAt }`, where `version` is `FLOW_FILE_VERSION` (1).
`decodeFlowFile(text)` returns `{ ok: true, flow, notices }` or `{ ok: false,
problem }` for any text: it does not throw. A file without a `version` is
version 1. A format change raises the number and adds the step that brings the
previous version forward; a file of a newer version is refused with a message
that says to update.

**D2 — A file is refused only when it cannot be a flow.** That is: text that
is not JSON; no `data.nodes` and `data.edges` arrays; a node or an edge that
is not an object or has no id (a non-empty string); an edge without a source
or a target; two nodes
or two edges with one id (the document is keyed by id, so the second would
replace the first unseen); a version that is not a whole number of 1 or more;
a file beyond the limits. The limits bound what one import can cost: 64 MB
(`MAX_FLOW_FILE_SIZE`, checked on the file's size before it is read), 5,000
nodes, 20,000 edges, 64 levels of nesting.

**D3 — Everything else is read as the store reads it, and said.** Nodes go
through the document's own read path (`FlowDocument.setFlowData` then
`getNodes`), so a missing type, position or size becomes what it is in a
stored flow. Settings go through the
[Node Data Resolver](../../CONTEXT.md#node-data-resolver): a setting the file
lacks gets its default, a setting the schema does not name is kept, and when
the resolver would change a value the file has, the file's settings stand
untouched.

Edges go through `decodeEdge` (`packages/collab/src/schema.ts`), the reading
the document gives a stored edge. It keeps an edge's id, its two nodes, the
handle it names at each end (a non-empty string; anything else is no handle)
and its type when that is `EDGE_TYPE`, and nothing else. A value with no usable
id, source or target is an `EdgeDefect`, and the file is refused. The
document's readers (`getEdges`, `getEdge`, `getFlowData`) read a stored edge
the same way and leave out one with an `EdgeDefect` or with no handle at either
end; such an edge stays in the document, unshown and unrun, and nothing deletes
it for being there. So a file and a document agree on what an edge is.

Of the decoded edges, one to a node that is not in the file is left out, since
it attaches to nothing, and so is one that names no handle at an end: it
carries nothing, the canvas cannot draw it, and sketch generation needs both
handles of every edge. Every other edge is kept, whatever handle it names;
`endVerdict` is the one place that decides this, and it does not compile until
every `EdgeProblem` reason has a line.

**D4 — Each difference is a notice.** A `FlowFileNotice` has a `kind`, the id
it is about and one sentence for the user: `name-shortened`,
`unknown-node-type`, `position-defaulted`, `settings-defaulted`,
`settings-unrecognised`, `edge-dropped`, `unknown-handle`, `edges-not-drawn`.
A flow this build exported decodes with no notices. `importFlowFile`
(`import-flow.ts`) turns a decode into an `ImportReport`: the most important
notices in full, the rest counted by kind, so nothing left out goes
unmentioned. File content reaches a message only clipped.

**D5 — Content lands through one rule.** `openFlowFromContent(content,
destination, landing)` (`open-flow.ts`) lands content in the signed-in user's
account when somebody is signed in, as a new flow that the caller's
`FlowDestination.account` creates, and in the local flow otherwise; then it
sets the active flow and opens the editor. Every caller has an `account`
creator: an import passes `flow.createFromImport`, a Community fork passes
`community.fork`, and a template passes `flow.createFromImport` through
`openTemplate` ([ADR-0042](0042-a-template-lands-in-the-account.md)). A
failure is a result, not a rejection, and leaves the active flow as it was;
content the account did not take never lands in the local flow instead.
`useOpenFlow` (`use-open-flow.ts`) binds it to the app.

## Considered options

- **Validate strictly and reject on any defect.** A flow exported by an older
  release, or one holding a value the app itself still opens, would stop
  importing. The user would have to edit JSON by hand.
- **Repair silently.** Resetting settings a schema rejects loses what the user
  chose, and dropping edges without a word changes what the flow does.
- **Validate on the server in `flow.createFromImport`.** A signed-out import
  never reaches the server, and the node schemas live in the web app.

## Consequences

- A flow behaves the same whether it was opened from the store or imported
  from a file. The cost is that an import can produce a flow with parts that
  do not run; the notices are the only signal, and they are toasts.
- The codec is the third caller of the Node Data Resolver, after Ask AI's flow
  tools and the templates. It is React-free and loads no node UI.
- Decode runs on the main thread. The limits bound it; a file near them still
  blocks the page while it is read.
- `MAX_NAME_LENGTH` (100) repeats a literal from
  `packages/api/src/routers/flow.ts`. The two can drift.
- `flow.createFromImport` still accepts any array. The server trusts the
  client's decode for a signed-in import.
- An import always creates or replaces a whole flow. The editor exports the
  open flow and has no import.

## What this does NOT decide

- Where a template lands and what choosing one twice does: that is
  [ADR-0042](0042-a-template-lands-in-the-account.md).
- The edges the session removes once a flow is open: that is handle pruning
  ([ADR-0032](0032-live-handle-set-and-handle-pruning.md)), and it never acts on an edge merely because it is there.
- Server-side validation of imported content.
- The format of version 2.

## References

- `apps/web/src/flows/flow-file.ts` — `encodeFlowFile`, `decodeFlowFile`, `refuseFlowFileOfSize`, `FlowFileNotice`, `FLOW_FILE_VERSION`, `endVerdict`.
- `apps/web/src/flows/import-flow.ts` — `importFlowFile`, `ImportReport`.
- `apps/web/src/flows/open-flow.ts`, `use-open-flow.ts` — `openFlowFromContent`, `FlowDestination`, `useOpenFlow`.
- `apps/web/src/flows/use-flow-import-export.ts` — the download, the file picker and the toasts.
- `apps/web/src/flows/fixtures/export-at-22ac4da.json` — an export from before the codec, which decodes with no notices.
- `apps/web/src/nodes/handles.ts` — `checkEdgeEnds`, `EdgeProblem`.
- `packages/collab/src/schema.ts` — `decodeEdge`, `EDGE_TYPE`, `EdgeDefect`, and `FlowDocument.getEdges` / `getEdge` / `getFlowData`.
- `CONTEXT.md` § Flow File, Flow File Notice, Open flow from content.
