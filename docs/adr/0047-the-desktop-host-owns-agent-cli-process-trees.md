# ADR-0047 — The desktop host owns every agent CLI process tree, and a stop names its run

- **Status:** accepted (2026-11-19)
- **Date:** 2026-11-19
- **Deciders:** sander
- **Amends:** [ADR-0024](0024-flow-tools-over-mcp-for-agent-clis.md), [ADR-0039](0039-agent-cli-port.md)

> **Decision:** every agent CLI process the desktop app starts is started and
> ended by one owner in the Rust host, `AgentCliRuns`
> (`apps/web/src-tauri/src/cli_llm/runs.rs`). The webview names each run when
> it starts it and stops it by that name (`llm_cli_stop`). Ending a run ends
> the whole process tree: a unix process group, asked with `SIGTERM` and killed
> with `SIGKILL` after `STOP_GRACE` (2 s), or a Windows job object. A run ends
> when its turn is stopped, when the page that asked for it is gone, or when
> the app quits.

## Context

An agent CLI spends the user's tokens for as long as it runs and, while its
[Flow Tool Server](../../CONTEXT.md#flow-tool-server) session is open, can
edit the flow. Stop closed the session ([ADR-0024](0024-flow-tools-over-mcp-for-agent-clis.md)),
which cut the CLI off from the flow, but the process ran to completion: the
host kept no handle on it, and the [Agent CLI Port](../../CONTEXT.md#agent-cli-port)
had no way to end one ([ADR-0039](0039-agent-cli-port.md)). A reload or a
closed panel left the process running too.

Three facts shape the fix.

- **A Tauri command cannot be taken back once invoked**, so the stop has to be
  a second command that finds the first one's process.
- **Two commands invoked one after the other are not polled in that order.** A
  stop can reach the host before the run it is for.
- **An agent CLI starts processes of its own**: the relay to the app's MCP
  server, and whatever its tools run. Ending only the process the app spawned
  leaves those running.

## Decision

**D1 — One owner.** `AgentCliRuns` starts every agent CLI process and is the
one place a process is ended: by `stop(name)` when its turn is stopped,
`stop_all()` when the page that asked for it is gone, `shutdown()` when the
app quits, and when the future waiting on it is dropped. A process that exits
by itself is left as it ended.

**D2 — A run has a name.** The webview's adapter (`tauri-agent-cli.ts`) gives
each run a new `uid()` and passes it to `llm_cli_generate`. When the run's
`signal` aborts, it sends `llm_cli_stop { run }` and rejects at once with the
signal's reason. A stop that names a run that is over finds nothing to end. A
stop that names a run that has not started is kept (up to 32), and a run that
starts under that name is not started.

**D3 — Ending a run ends its tree.** On unix the process is started as the
leader of its own process group. Ending asks the group with `SIGTERM` first,
because a CLI that is asked ends the processes it moved out of its group, and
kills the group with `SIGKILL` if it has not ended within `STOP_GRACE`. On
Windows the process is put in a job object, which every process it starts
joins; ending terminates the job, with no grace, and the job is also
terminated when its handle closes, which the OS does if the app dies.

**D4 — Every way a turn is abandoned stops its run.** Stop in the Ask AI panel;
closing the panel or switching flow (the `useAskAi` effect aborts the turn); a
page reload (`on_page_load` → `cli_llm::page_gone`, which stops every run and
ends the MCP session); and the app quitting (`RunEvent::Exit` →
`cli_llm::quit`, which holds up the exit for at most `STOP_GRACE`). The flow
tool session closes at the stop.

## Considered options

- **Close the session and let the process run.** It keeps the flow safe but
  spends the user's tokens on an answer nobody reads, and the process outlives
  a reload.
- **Kill only the spawned process.** The relay and the tools' processes stay.
- **Stop by process id from the webview.** The webview would learn the pid
  only after the run started, which a stop can overtake, and a reused pid could
  name another process.

## Consequences

- A stopped turn ends its CLI within `STOP_GRACE`; nothing it printed is
  returned and it makes no tool call after the stop.
- A CLI that traps `SIGTERM` is killed after 2 s; one that does not gets the
  chance to end its own children and close its session file.
- Quitting the app waits up to 2 s for running CLIs.
- The [Scripted Agent CLI](../../CONTEXT.md#scripted-agent-cli) plays the same
  rule: a run lives as long as its signal.

## What this does NOT decide

- Streaming a CLI's output to the turn.
- Which CLIs can take the flow tools ([ADR-0024](0024-flow-tools-over-mcp-for-agent-clis.md)).

## References

- `apps/web/src-tauri/src/cli_llm/runs.rs` — `AgentCliRuns`, `STOP_GRACE`, `EARLY_STOPS`.
- `apps/web/src-tauri/src/cli_llm.rs` — `llm_cli_generate`, `llm_cli_stop`, `page_gone`, `quit`.
- `apps/web/src-tauri/src/lib.rs` — `on_page_load`, the exit handler.
- `apps/web/src/ai/agent-cli-port.ts` — `AgentCliPort.run`'s `signal`.
- `apps/web/src/ai/tauri-agent-cli.ts`, `scripted-agent-cli.ts`, `use-ask-ai.ts`.
- `CONTEXT.md` § Agent CLI run.
