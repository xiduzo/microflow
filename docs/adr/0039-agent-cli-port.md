# ADR-0039 — One port to the host that runs an agent CLI; the logic stays above it

- **Status:** accepted (2026-11-19)
- **Date:** 2026-11-19
- **Deciders:** sander
- **Extends:** [ADR-0024](0024-flow-tools-over-mcp-for-agent-clis.md)

> **Decision:** everything the webview asks of the desktop host to run an agent
> CLI goes through one type, `AgentCliPort` (`apps/web/src/ai/agent-cli-port.ts`):
> run a process once, open and close the flow tool session, hear tool calls and
> answer them. It has two adapters: `tauri-agent-cli.ts`, which is one Tauri
> primitive per method and decides nothing, and `scripted-agent-cli.ts`, a
> recorded process played back in memory with the host's session rules kept.
> The argument vector, the prompt, the token, the roster, the budget, the
> argument gate and the session's lifetime all live above the port, where
> `bun test` reaches them.

## Context

Running a local agent CLI takes two things only the desktop host has: a
subprocess, and the MCP server that process calls back into for the turn's flow
tools ([ADR-0024](0024-flow-tools-over-mcp-for-agent-clis.md)). `CliTextAdapter`
reached the first through a dynamic import of `platform/ipc`, and
`mcp-bridge.ts` reached the second by importing `@tauri-apps/api`.

So the adapter had no tests at all, and the bridge's tests replaced Tauri
process-wide with `mock.module` and handed the bridge tools carrying zod
schemas, a shape no real turn produces. Three properties ADR-0024 states did
not hold on the path a turn takes, and nothing failed:

- **Stop did not close the session.** `chat()` hands an adapter the turn's abort
  signal as `request.signal`. The adapter read `abortSignal`, which `chat()`
  never sets, so a stopped turn left its session open until the process exited
  and the CLI could still edit the flow.
- **`tools/list` showed an empty schema.** `chat()` converts each tool's zod
  schema to JSON Schema before an adapter sees it. The bridge ran
  `z.toJSONSchema` on that, which throws, and fell back to
  `{ type: "object", properties: {} }` for every tool.
- **No call was validated.** The argument gate needed a zod parser, which a
  tool from a turn does not have. `connect {}` reached the tool.

The strings that cross to Rust (`llm_cli_generate`, `mcp_session_start`,
`mcp_tool_result`, `mcp_session_end`, the `mcp-request` event and their argument
names) are checked by neither compiler. A typo in one ships as a tool call that
waits out the 30-second deadline.

## Decision

**D1 — One port, as narrow as the host.** `AgentCliPort` has five methods:
`run({ bin, args, stdin, signal })` resolves with stdout once the process exits
0 and rejects with a message fit to show the user, or with the signal's reason
when `signal` aborts, which ends the process
([ADR-0047](0047-the-desktop-host-owns-agent-cli-process-trees.md)); `openSession({ token, tools,
budget })` resolves with the `RelayCommand` a CLI must spawn, or `null` when no
MCP transport is listening; `onToolCall(handler)`; `answerToolCall(id,
outcome)`; `closeSession(token)`. A run is one call and one string, because
`llm_cli_generate` collects stdout and resolves once. Nothing streams and no
exit code crosses the port. `cli-adapter.ts` and `mcp-bridge.ts` take the port
as a dependency and import no Tauri.

**D2 — The desktop adapter decides nothing, and its wire is pinned.**
`createTauriAgentCli(primitives)` maps each method onto one Tauri primitive
(`invokeCommand`, `invoke`, `listen`), except `run`, which is two commands: a
Tauri command cannot be taken back once invoked, so `llm_cli_generate` starts
the process under a name the adapter gives it and `llm_cli_stop` ends the
process of that name when the run's signal aborts. `tauriAgentCli` is that
function on the real ones, loaded on demand by `cli-adapter.ts`. `tauri-agent-cli.test.ts`
checks every command name, argument name and payload it sends against the Rust
source: the `#[tauri::command]` signatures in `cli_llm.rs` and `mcp/session.rs`,
the handler list in `lib.rs`, the `ToolSpec` and `RelayCommand` structs and the
`mcp-request` event fields.

**D3 — The second adapter is a recorded process.** `scriptedAgentCli(script)`
plays back what one process did, in order: stdout and stderr writes, flow tool
calls over MCP, a hold, an exit code. It keeps the host rules the code above
the port depends on, each taken from the Rust it stands in for: stdout arrives
whole and only after exit; a non-zero exit rejects with the host's message; a
run lives as long as its signal, and one whose signal has already aborted
starts nothing; one
session at a time, and opening replaces; a call is checked token first, then
roster, then budget, and only then sent up; every subscriber hears every call;
closing fails every call in flight. It is test support only; nothing in the app
imports it.

**D4 — The logic and the ADR-0024 properties live above the port.**
`cli-adapter.ts` owns the argument vector, the prompt, what stdout becomes and
the order of the stream's events. `mcp-bridge.ts` owns the session token, the
roster, the call budget (`CALL_BUDGET`), which session may answer a call, and
when a session closes. Tests state those properties as what a scripted process
can reach.

**D5 — Stop arrives as `request.signal`.** `CliTextAdapter.run` is the one place
a CLI is started and checks the signal first, on every path (with a session,
without one, and for `structuredOutput`), so a turn stopped before its CLI
starts never starts it. It hands the signal to `AgentCliPort.run`, which ends
the process when it aborts. `withFlowToolServer` checks the signal before it
opens a session and again before it starts the run, and closes the session when
the signal aborts mid-run.

**D6 — The published schema is the gate.** `tools/list` shows the JSON Schema a
tool arrives with, the one `chat()` derives from the tool's zod schema. The
bridge builds one gate per tool from that same object (`z.fromJSONSchema`) and
runs nothing on arguments it does not accept; the refusal names every problem
under its field ("invalid arguments for connect: source is required"). The
tool is handed the arguments as the CLI sent them. A schema zod has no check
for (`not`, `if`/`then`/`else`), or one that is not JSON Schema, fails the
publish before a session opens.

## Considered options

- **Keep `mock.module` on the Tauri API.** No new type, but the replacement is
  process-wide, it models `invoke` rather than a process, and it cannot express
  "the CLI calls a tool while it is still running".
- **Run a real CLI in tests.** It needs a binary, credentials and a model, and
  none of the properties under test are the model's.
- **A general JSON Schema validator for the gate.** Another dependency for
  constructs the flow tools do not use; zod reads back everything its own
  conversion writes.

## Consequences

- The adapter and the bridge run in `bun test` through `chatStream`,
  `structuredOutput` and `withFlowToolServer`, including whole Ask AI turns on
  the real turn runner and flow tools.
- A rename on either side of the Tauri wire fails a test instead of timing out
  in the app.
- The scripted host is a second statement of the Rust session rules. A change
  to `McpState::call` has to be made there too, and no guard forces that.
- The 30-second call deadline is not modelled. A script that leaves a call
  unanswered while its session stays open hangs until the test times out, and
  no test may depend on the deadline's message.
- The gate is not a general JSON Schema validator. Three shapes are accepted
  and not enforced: object keywords on a schema with no `type: "object"`,
  `required` with no `properties`, and `propertyNames` that is untyped or sits
  beside `properties`. A schema derived from zod has none of them.

## What this does NOT decide

- Which CLIs can take the flow tools; that is `CliProvider.mcpArgs` and
  `hostLimitation` ([ADR-0024](0024-flow-tools-over-mcp-for-agent-clis.md)).
- The session rules themselves (token, budget, deadline, one live session);
  ADR-0024 decides them and `mcp/session.rs` enforces them.
- Streaming a CLI's output, which needs a change on the Rust side
  (`cli_llm.rs`) and a wider port.
- How the host ends a process tree
  ([ADR-0047](0047-the-desktop-host-owns-agent-cli-process-trees.md)).
- The LLM transport seam `adapterFor`
  ([ADR-0021](0021-one-llm-transport-in-the-webview.md)), which is untouched.

## References

- `apps/web/src/ai/agent-cli-port.ts` — `AgentCliPort`, `RelayCommand`, `ToolSpec`, `ToolCall`, `ToolOutcome`.
- `apps/web/src/ai/tauri-agent-cli.ts`, `tauri-agent-cli.test.ts` — the desktop adapter and its wire test.
- `apps/web/src/ai/scripted-agent-cli.ts` — the recorded process.
- `apps/web/src/ai/cli-adapter.ts`, `cli-adapter.test.ts` — `cliAdapterFor`, `AgentCliPortResolver`.
- `apps/web/src/ai/mcp-bridge.ts`, `mcp-bridge.test.ts` — `withFlowToolServer`, `CALL_BUDGET`, the gate.
- `apps/web/src-tauri/src/cli_llm.rs`, `cli_llm/runs.rs`, `apps/web/src-tauri/src/mcp/session.rs` — the host side.
- `CONTEXT.md` § Agent CLI Port, Scripted Agent CLI, Flow Tool Server.
