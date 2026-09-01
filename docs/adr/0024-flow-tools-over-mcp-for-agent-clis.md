# ADR-0024 — Ask AI's flow tools are published over MCP, so an agent CLI can drive them

- **Status:** accepted — implemented (2026-09-01)
- **Date:** 2026-09-01
- **Deciders:** sander
- **Extends:** [ADR-0021](0021-one-llm-transport-in-the-webview.md) (the Ask AI
  half; the transport seam `adapterFor` is untouched)

## Context

ADR-0021 made `adapterFor` the one transport seam, and a local agent CLI
(`cli-adapter.ts`) satisfies it: Ask AI could pick Claude Code as a provider and
get an answer.

It could not get an *edit*. `chat()` hands every adapter the turn's `tools` and
expects the adapter to put them on the wire and read tool calls back off it. A
print-mode CLI has no such wire — it has its own agent loop and its own tool
protocol. So a turn against a CLI answered in prose and changed nothing, and
`hostLimitation` had to warn about it with a "no flow tools" badge to stop the
feature from silently under-delivering.

That badge was the problem. These CLIs are the best models many users have
configured, already authenticated, with no key to paste — and they were the one
provider that could not do the thing the panel exists for.

The CLI's tool protocol is MCP. So the question is not how to fake tool calls
out of prose, but where the tools should live so a CLI can call them.

## Decision

**The desktop app hosts an MCP server, and publishes Ask AI's flow tools on it
for the length of one turn.**

```text
Ask AI  ─spawn─▶  claude -p --mcp-config …
 (webview)              │ stdio
                        ▼
                  microflow --mcp <token>       ← the same binary, `mcp::relay`
                        │ unix socket / named pipe
                        ▼
                  mcp::serve                    ← src-tauri/src/mcp/
                        │ "mcp-request" event + `mcp_tool_result` command
                        ▼
                  createFlowTools               ← back in the webview, on the Yjs doc
```

- **The tools are not reimplemented in Rust.** They mutate the collaborative
  `FlowDocument`, which lives in the webview — that is what makes an AI edit
  sync, undo, and reach a board like a human one (ADR-0021). A Rust copy would
  be a second definition of every tool plus a parity guard. Every `tools/call`
  is a round trip up into the page instead. `mcp/session.rs` owns that hop.
- **A unix socket at `0600`, or a Windows named pipe** — not a port. MCP's stdio
  transport means the *client* spawns its server, so we must be reachable from a
  fresh process that shares nothing with us. `microflow --mcp` is the same
  binary in a mode that returns before Tauri boots, so `single_instance` never
  sees it. No port, no bearer token in a URL, no CORS, nothing on a network
  interface.
- **Exposure is a session, not a server.** An idle Microflow answers `tools/list`
  with `[]` and refuses every call. `withFlowToolServer` (`lib/ai/mcp-bridge.ts`)
  opens a session for the duration of one turn and closes it in a `finally`, so
  there is no `open()` a caller can forget to pair.
- **A token, because the socket is not the authorisation.** `0600` keeps other
  users out; every process *this* user runs can still connect. The relay presents
  the session's token as a `microflow/attach` notification before anything else,
  and a connection that does not sees exactly what an idle app shows.
- **Per-CLI, not per-provider-kind.** `CliProvider.mcpArgs` says how one CLI is
  pointed at an MCP server *for a single run*. Absent means it cannot be, and
  `hostLimitation` keeps saying "no flow tools" for it. Claude Code has it;
  opencode, codex, gemini, copilot and pi take MCP servers from a config file in
  the user's home, which would leave the flow tools attached to every unrelated
  session they ever run.
- **The CLI is spawned with our tools and nothing else.** `--restricted --tools
  "" --strict-mcp-config` removes its built-in toolbox, its user/project
  settings, and the MCP servers the user configured for their own work. The user
  asked to edit a flow, not to be agented at.

### The bounds, and why each one exists

The agent loop moved *inside* the CLI, so `MAX_ITERATIONS` in `turn-runner.ts`
no longer bounds anything for these providers. Four bounds replace it, in
`mcp/session.rs` and `mcp-bridge.ts`:

| bound | what it stops |
|---|---|
| **Call budget** (40/turn) | a confused model editing the document a thousand times. Spending it is not a kill: further calls answer "you are out of calls, summarise what you changed", which a model can act on. |
| **Call deadline** (30s) | a busy or reloading webview leaving the CLI — and the user — waiting on a reply that is never coming. |
| **Session close fails everything in flight** | an aborted turn leaving a CLI blocked on a tool with nowhere to run. |
| **One live session, newest wins** | Tauri broadcasts events by name, so two live listeners would both run one `add_node` and the flow would gain two nodes. |

**Stop is the session, not the process.** Aborting a turn closes the session
immediately, so the CLI cannot touch the flow again whatever it goes on to
decide. The subprocess itself runs to completion in the background; killing it
needs a child-handle table in `cli_llm.rs` and is not worth one yet.

### Consequences worth stating plainly

- **`confirm` mode needed no protocol work.** MCP has no approval round trip,
  but `createFlowTools` already stages instead of writing in that mode and
  returns "staged for the user to approve" as the tool result. The CLI reads a
  truthful answer; the user approves the batch as one undo step, exactly as with
  an HTTP provider.
- **`chatStream` yields `TOOL_CALL_*` for work it did not perform.** The events
  come from the bridge as calls arrive, so the panel shows tools running while
  the process is still going. It is a report, not a request — nothing waits on a
  result, because the CLI already has it.
- **The tool schema cannot drift from the tool.** `tools/list` is `z.toJSONSchema`
  of the tool's own zod schema, so what the CLI is shown is what its call is
  validated against.
- **Claude Desktop and any other MCP client can connect too** — and get nothing,
  until a turn is open and they present its token. That is a deliberate
  non-feature: a standing "edit my flow" grant to every process on the machine
  is not the same thing as this.
- **Nothing is listening is a supported state.** `mcp_session_start` answers
  `null` when no transport bound, and Ask AI runs the CLI without an MCP server
  — the prose turn it did before this existed.

## Rejected

- **Teaching `cli-adapter.ts` to fake tool calls out of prose** — serialise the
  tools into the system prompt and run stdout through `recoverToolCalls`, which
  already exists for small local models. Cheaper (~40 lines) and it keeps
  TanStack's loop in charge, but every iteration is a fresh process with no
  session, the transcript is replayed as labelled text, and Claude Code runs its
  own agent loop *inside* each spawn: an agent nested in an agent, negotiating
  through a text protocol neither side chose. MCP is the protocol both sides
  already speak.
- **MCP over localhost HTTP**, which `--mcp-config` also accepts. It would need a
  port, a bearer token, and either a hand-rolled HTTP/1.1 parser or a server
  crate (axum/hyper) in a desktop app that ships to users. The socket needs
  none of that and the OS does the access control.
- **The official `rmcp` SDK.** Spec-correct and it would delete the JSON-RPC
  framing here — but the surface we need is `initialize`, `ping`, `tools/list`,
  `tools/call`, and it brings a tower/hyper tree along for it.
- **Enabling every CLI by writing an MCP config file into its home directory.**
  It is the only way to reach opencode and the others, and it grants the flow
  tools to every session that CLI ever runs, indefinitely. The session-scoped
  grant is the security model; a config file is not a session.
- **Reimplementing the flow tools in Rust to avoid the webview hop.** Two
  definitions of `add_node`, and a parity guard to keep them honest, to save a
  sub-millisecond round trip.
