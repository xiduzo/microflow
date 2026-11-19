// The port to the host that runs an agent CLI.
//
// Running a local agent CLI takes two things only the desktop host has: a
// subprocess, and the MCP server that process calls back into for the turn's
// flow tools (ADR-0024). This type is the whole of what the webview asks of the
// host for both, and it is the seam `cli-adapter.ts` and `mcp-bridge.ts` take as
// a dependency instead of importing Tauri.
//
// Two adapters satisfy it:
//
// - `tauri-agent-cli.ts`: the desktop host. Tauri primitives and no decision of
//   its own; its test pins every name it sends against the Rust.
// - `scripted-agent-cli.ts`: a recorded process, played back in memory, with the
//   host's rules kept: the session's (token, roster, budget, close) and the
//   run's (a process that is ended does nothing more). It is how everything
//   above this seam runs in `bun test`.
//
// The port is as narrow as the host: a run is one call and one string, because
// `llm_cli_generate` collects stdout and resolves once. Nothing here streams
// output, and no exit code crosses it: a failed run is a rejection whose message
// the host already wrote for the user.
//
// A run ends in one of two ways: the process exits, or the `signal` it was
// started with aborts and the host ends it. There is no method to stop a run,
// so there is none to forget: whoever can abandon a turn already holds its
// signal.
//
// What stays above the seam, deliberately: the argument vector, the prompt, the
// session token, the tool roster, the call budget, which session may answer a
// call, and when a session closes. Those are the adapter's and the bridge's
// logic and the ADR-0024 security properties, so they live where a test can
// reach them.

/** The command a CLI spawns to reach the host's MCP server. Built by the host,
 *  which is the only side that knows its own executable path. */
export type RelayCommand = { bin: string; args: string[] };

/** A tool as `tools/list` describes it to the CLI. */
export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };

/** One tool call the CLI made, waiting on an answer. */
export type ToolCall = { id: number; name: string; arguments: unknown };

/** What the CLI is told a tool call came to. `error` is a tool error: the model
 *  reads it and corrects itself. */
export type ToolOutcome = { result: unknown } | { error: string };

export type AgentCliPort = {
  /**
   * Run an agent CLI once and collect what it printed.
   *
   * `bin` is a bare binary name the host checks against its own allowlist;
   * `args` never reaches a shell; `stdin` is written and the pipe closed.
   * Resolves with stdout once the process exits 0. Rejects with an `Error`
   * when the binary is not allowed, not installed, cannot start, or exits
   * non-zero; the message is fit to show the user as it is.
   *
   * `signal` is the run's whole lifetime. When it aborts, the host ends the
   * process and every process it started, and the run rejects at once with the
   * signal's reason: nothing the process printed is returned, and it makes no
   * tool call after that. A signal that has already aborted starts nothing. A
   * signal that aborts after the run has settled does nothing, so it can never
   * end another run.
   */
  run(invocation: {
    bin: string;
    args: string[];
    stdin: string;
    signal?: AbortSignal;
  }): Promise<string>;

  /**
   * Open the Flow Tool Server session for one turn.
   *
   * The host serves `tools` to a client that presents `token`, and to no other,
   * for at most `budget` calls. Opening replaces a session that is already
   * open. Resolves with the relay command a CLI must spawn to reach the
   * session, or `null` when the host has no MCP transport listening, in which
   * case nothing was opened.
   */
  openSession(session: {
    token: string;
    tools: ToolSpec[];
    budget: number;
  }): Promise<RelayCommand | null>;

  /**
   * Hear the tool calls the host sends up to the webview.
   *
   * The host sends a call up only once it has passed the open session's own
   * checks: the caller presented the session's token, the name is in the
   * session's roster, and the budget is not spent. Everything else it refuses
   * itself.
   *
   * Calls are broadcast: every subscriber hears every call, whichever session
   * it was made in, so a subscriber decides for itself whether a call is its to
   * answer. Resolves with the function that unsubscribes.
   */
  onToolCall(handler: (call: ToolCall) => void): Promise<() => void>;

  /** Answer one tool call. An answer to a call nobody waits on any more (it
   *  was answered, or its session closed) is dropped. */
  answerToolCall(id: number, outcome: ToolOutcome): Promise<void>;

  /** Close the session `token` opened, if it is still the open one, and fail
   *  every call in flight. A token that names no open session does nothing. */
  closeSession(token: string): Promise<void>;
};
