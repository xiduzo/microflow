// A recorded agent CLI process, played back in memory: the second adapter for
// `AgentCliPort`. Test support only — nothing in the app imports this module.
//
// A script is what one process did, in order: what it wrote, which flow tools it
// called over MCP, and how it exited. `run` plays it back one step per turn of
// the event loop, which is the timing a subprocess has from the webview's side:
// a tool call arrives while the process is still running, and stdout arrives
// only once it has exited.
//
// It keeps the host behaviour the code above the port depends on, each rule
// taken from the Rust it stands in for:
//
// - `cli_llm.rs::run`: stdout is collected and returned whole and trimmed, so
//   chunk boundaries are invisible above the port. A non-zero exit rejects with
//   `<bin>: <stderr>`, or `<bin> exited with exit status: <code>` when stderr is
//   empty. stderr never reaches the answer of a run that succeeded.
// - `cli_llm/runs.rs`: a run lives as long as its `signal`. When the signal
//   aborts the process is ended where it stands: it takes no further step, so
//   it makes no further tool call, it is told nothing of a call it was waiting
//   on, and nothing it wrote is returned. The run rejects with the signal's
//   reason. A signal that has already aborted starts no process, and one that
//   aborts after the process exited ends nothing.
// - `mcp/session.rs`: one session at a time, and opening replaces. A call is
//   checked in `McpState::call`'s order. First the token: a process reaches the
//   session only if it was spawned with the session's token in its arguments,
//   which is the only way a real CLI learns it. Then the roster: a name the
//   session did not publish is refused and spends nothing. Then the budget: each
//   call that gets this far spends one, and a spent budget is refused. Only then
//   is the call sent up. Closing fails every call in flight, and needs the token
//   that opened. A second answer to one call is dropped.
// - The `mcp-request` event: every subscriber hears every call, and a call is
//   sent up whether or not anyone is subscribed.
//
// One host rule is left out on purpose: the 30-second call deadline. Time is
// not modelled, so a call nobody answers (no subscriber, or none that acts)
// waits until its session closes, where the host would answer "did not answer
// within 30s". No test may depend on that message or on the wait: a script that
// leaves a call unanswered while its session stays open hangs, and the test
// fails on its timeout.

import type { AgentCliPort, RelayCommand, ToolCall, ToolOutcome, ToolSpec } from "./agent-cli-port";

/** One thing the recorded process did. */
export type ScriptStep =
  /** Wrote to stdout. */
  | { stdout: string }
  /** Wrote to stderr. */
  | { stderr: string }
  /** Called a flow tool over MCP and waited for its result, as an MCP client does. */
  | { call: string; arguments?: unknown }
  /** Kept running until the test lets it go on, or the run is ended. */
  | { hold: Promise<unknown> }
  /** Exited. A script with no `exit` step exits 0 after its last step. */
  | { exit: number };

/** What one `run` was started with. */
export type Invocation = { bin: string; args: string[]; stdin: string };

/** A session as the host holds it. */
export type ScriptedSession = {
  token: string;
  tools: ToolSpec[];
  /** Calls left. */
  budget: number;
  open: boolean;
};

export type ScriptedAgentCli = AgentCliPort & {
  /** Every process started, in order. */
  readonly runs: Invocation[];
  /** Every session opened, in order, with its current state. */
  readonly sessions: ScriptedSession[];
  /** What the process was told each of its tool calls came to, in order. */
  readonly toolResults: Array<{ name: string } & ToolOutcome>;
  /** Whether a process is running right now: started, and neither exited nor
   *  ended by its signal. */
  readonly running: boolean;
  /** How many `onToolCall` subscribers have not unsubscribed. */
  readonly subscribers: number;
};

/** Where the relay lives in a packaged desktop app. Only its shape matters. */
const RELAY_BIN = "/Applications/Microflow.app/Contents/MacOS/Microflow";

const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A host that plays `script` back for every `run`.
 *
 * `script` may be a function of the invocation, for a process whose behaviour
 * depends on how it was started. `listening: false` is a host whose MCP
 * transport never bound.
 */
export function scriptedAgentCli(
  script: ScriptStep[] | ((invocation: Invocation) => ScriptStep[]),
  { listening = true }: { listening?: boolean } = {},
): ScriptedAgentCli {
  const runs: Invocation[] = [];
  const sessions: ScriptedSession[] = [];
  const toolResults: Array<{ name: string } & ToolOutcome> = [];
  const listeners = new Set<(call: ToolCall) => void>();
  /** Calls sent up to the webview and not yet answered. */
  const pending = new Map<number, (outcome: ToolOutcome) => void>();
  let live: ScriptedSession | undefined;
  let nextId = 1;
  let alive = 0;

  const failPending = (reason: string) => {
    const waiting = [...pending.values()];
    pending.clear();
    for (const settle of waiting) settle({ error: reason });
  };

  /** One `tools/call` from a process started with `args`. */
  const callTool = (args: string[], name: string, input: unknown): Promise<ToolOutcome> => {
    const session = live;
    if (!session || !args.some((arg) => arg.includes(session.token))) {
      return Promise.resolve({
        error:
          "Microflow has no Ask AI turn open, so its flow tools are not available right now.",
      });
    }
    if (!session.tools.some((tool) => tool.name === name)) {
      const exposed = session.tools.map((tool) => tool.name).join(", ");
      return Promise.resolve({ error: `no tool '${name}' — this turn exposes: ${exposed}` });
    }
    session.budget -= 1;
    if (session.budget < 0) {
      return Promise.resolve({
        error:
          "you have used every tool call allowed for this turn — stop calling tools and summarise what you changed.",
      });
    }

    const id = nextId++;
    return new Promise<ToolOutcome>((resolve) => {
      pending.set(id, resolve);
      for (const listener of listeners) listener({ id, name, arguments: input });
    });
  };

  return {
    runs,
    sessions,
    toolResults,
    get running() {
      return alive > 0;
    },
    get subscribers() {
      return listeners.size;
    },

    async run({ signal, ...invocation }) {
      signal?.throwIfAborted();
      runs.push(invocation);
      const steps = typeof script === "function" ? script(invocation) : script;
      let stdout = "";
      let stderr = "";
      let code = 0;

      // The process, for as long as nothing ends it. `ended` is checked after
      // every wait: a process that has been ended takes no further step, and is
      // told nothing of a call it was waiting on.
      let ended = false;
      const play = async () => {
        for (const step of steps) {
          await nextTick();
          if (ended) return;
          if ("stdout" in step) stdout += step.stdout;
          else if ("stderr" in step) stderr += step.stderr;
          else if ("hold" in step) await step.hold;
          else if ("call" in step) {
            // `mcp/mod.rs`: a call that leaves `arguments` out is a call with `{}`.
            const input = step.arguments === undefined ? {} : step.arguments;
            const outcome = await callTool(invocation.args, step.call, input);
            if (ended) return;
            toolResults.push({ name: step.call, ...outcome });
          } else {
            code = step.exit;
            break;
          }
          if (ended) return;
        }
        await nextTick();
      };

      let end = () => {};
      const stopped = new Promise<never>((_, reject) => {
        end = () => {
          ended = true;
          reject(signal?.reason);
        };
      });
      signal?.addEventListener("abort", end, { once: true });

      alive += 1;
      try {
        await Promise.race([play(), stopped]);
      } finally {
        // Exited or ended, the run is over: a signal that aborts from here on
        // finds nothing to end.
        signal?.removeEventListener("abort", end);
        ended = true;
        alive -= 1;
      }

      if (code !== 0) {
        const detail = stderr.trim();
        throw new Error(
          detail
            ? `${invocation.bin}: ${detail}`
            : `${invocation.bin} exited with exit status: ${code}`,
        );
      }
      return stdout.trim();
    },

    async openSession({ token, tools, budget }): Promise<RelayCommand | null> {
      if (!listening) return null;
      if (live) {
        live.open = false;
        failPending("this Ask AI turn was replaced by a new one");
      }
      live = { token, tools, budget, open: true };
      sessions.push(live);
      return { bin: RELAY_BIN, args: ["--mcp", token] };
    },

    async onToolCall(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },

    async answerToolCall(id, outcome) {
      const settle = pending.get(id);
      pending.delete(id);
      settle?.("error" in outcome ? outcome : { result: outcome.result ?? null });
    },

    async closeSession(token) {
      if (live?.token !== token) return;
      live.open = false;
      live = undefined;
      failPending("the Ask AI turn ended");
    },
  };
}
