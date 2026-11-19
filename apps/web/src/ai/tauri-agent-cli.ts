// The desktop host as an `AgentCliPort`: the production adapter.
//
// Each method is one Tauri primitive: the commands in `src-tauri/src/cli_llm.rs`
// and `src-tauri/src/mcp/session.rs`, and the `mcp-request` event. It decides
// nothing; anything worth a test lives above the port.
//
// `run` is two commands, because a Tauri command cannot be taken back once it
// is invoked: `llm_cli_generate` starts the process under a name this adapter
// gives it, and `llm_cli_stop` ends the process of that name when the run's
// signal aborts. The host owns the process from there
// (`src-tauri/src/cli_llm/runs.rs`).
//
// What it does hold is the wire: command names, argument names and the event
// name are strings that neither compiler checks against the Rust side, and a
// typo in one ships as a tool call that times out after 30 seconds. So the
// adapter takes its Tauri primitives as an argument, and
// `tauri-agent-cli.test.ts` pins every name and payload it sends against the
// Rust source.
//
// This is the only module in `ai/` that reaches Tauri for an agent CLI, and it
// is loaded on demand (`cli-adapter.ts`), so nothing that does not run a CLI
// pulls the Tauri API in.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { uid } from "@/lib/uid";
import { invokeCommand } from "@/platform/ipc";

import type { AgentCliPort, RelayCommand, ToolCall } from "./agent-cli-port";

/** The Tauri primitives the adapter speaks through. */
export type TauriPrimitives = {
  invokeCommand: typeof invokeCommand;
  invoke: typeof invoke;
  listen: typeof listen;
};

export function createTauriAgentCli(tauri: TauriPrimitives): AgentCliPort {
  return {
    async run({ bin, args, stdin, signal }) {
      signal?.throwIfAborted();

      // The host knows the process by this name, and by nothing else: a stop
      // names the run it is for, so it cannot end any other.
      const run = uid();
      const exited = tauri.invokeCommand<
        { type: "llm_cli_generate"; run: string; bin: string; args: string[]; prompt: string },
        Record<string, unknown>
      >({ type: "llm_cli_generate", run, bin, args, prompt: stdin });

      let stop = () => {};
      const stopped = new Promise<never>((_, reject) => {
        stop = () => {
          // The host ends the process and everything it started. What it then
          // answers for the run is never read: the run is over here and now.
          void tauri.invokeCommand<{ type: "llm_cli_stop"; run: string }, Record<string, unknown>>({
            type: "llm_cli_stop",
            run,
          });
          reject(signal?.reason);
        };
      });
      signal?.addEventListener("abort", stop, { once: true });

      let response: Awaited<typeof exited>;
      try {
        response = await Promise.race([exited, stopped]);
      } finally {
        // The process has exited or been ended: from here on the signal has no
        // run to stop.
        signal?.removeEventListener("abort", stop);
      }

      if (!response.success) throw new Error(response.error);
      return typeof response.data === "string" ? response.data : String(response.data ?? "");
    },

    openSession: ({ token, tools, budget }) =>
      tauri.invoke<RelayCommand | null>("mcp_session_start", { token, tools, budget }),

    onToolCall: (handler) =>
      tauri.listen<ToolCall>("mcp-request", (event) => handler(event.payload)),

    async answerToolCall(id, outcome) {
      await tauri.invoke(
        "mcp_tool_result",
        "error" in outcome
          ? { id, result: null, error: outcome.error }
          : { id, result: outcome.result ?? null, error: null },
      );
    },

    async closeSession(token) {
      await tauri.invoke("mcp_session_end", { token });
    },
  };
}

/** The adapter on the real Tauri API. One instance for the app. */
export const tauriAgentCli: AgentCliPort = createTauriAgentCli({ invokeCommand, invoke, listen });
