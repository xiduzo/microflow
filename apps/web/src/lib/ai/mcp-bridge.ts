// Ask AI's flow tools, published to an agent CLI over MCP.
//
// An agent CLI cannot call `chat()`'s tools — it has no wire format for them
// and runs its own agent loop. It can call MCP tools. So for one turn the
// desktop app publishes this turn's tool set on its MCP server (`src-tauri/
// src/mcp/`), spawns the CLI pointed at it, and answers every `tools/call` by
// running the *same* `createFlowTools` tool the HTTP path uses. One definition,
// two ways in.
//
// This module is the webview half of that hop: it describes the tools for
// `tools/list`, answers `mcp-request` events, and owns the session's lifetime.
//
// ## Why the session is scoped to a callback
//
// `withFlowToolServer` opens the session, runs its callback, and closes in a
// `finally`. There is no `open()` for a caller to forget to pair — an aborted
// turn, a thrown adapter, a rejected spawn all land in the same close. That
// matters more than it looks: while a session is open, any process this user
// runs that guesses the token could edit the flow. Its lifetime *is* the
// security boundary, so it is not left to a caller's discipline.
//
// ## Why one session at a time
//
// Tauri events are broadcast by name, so two live listeners would both answer
// the same `mcp-request` — and both would run the write. The Rust side drops
// the second reply, but the second *write* would already have landed: a node
// added twice. `active` makes the newest session the only one that acts, which
// is also what the Rust side does with the token.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { z } from "zod";
import type { AnyTool } from "@tanstack/ai";

import { uid } from "@/lib/uid";

/**
 * How many tool calls one turn may make.
 *
 * The agent loop is inside the CLI now, so `MAX_ITERATIONS` in `turn-runner.ts`
 * does not bound it. Forty is "add a button that toggles an LED, get it wrong
 * twice, fix it" with room to spare, and far short of a confused model editing
 * the document a thousand times. Spending it is not fatal — the server starts
 * answering with "you are out of calls, summarise what you changed", which a
 * model can act on.
 */
export const CALL_BUDGET = 40;

/** The command a CLI spawns to reach this app's MCP server. Built in Rust,
 *  where `current_exe` is knowable. */
export type RelayCommand = { bin: string; args: string[] };

/** One `mcp-request` event: a tool the CLI called, waiting on an answer. */
type McpRequest = { id: number; name: string; arguments: unknown };

/** A tool as `tools/list` should describe it. */
type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };

/** The session that may answer `mcp-request` right now. */
let active: symbol | undefined;

/**
 * Describe one tool for `tools/list`.
 *
 * The JSON Schema is derived from the tool's own zod schema, so the schema the
 * CLI is shown and the schema the call is validated against are the same
 * object — the drift a hand-written MCP schema would invite cannot happen.
 * `unrepresentable: "any"` rather than the default throw: a tool whose schema
 * does not fully translate should still be callable, since the tool validates
 * its own input anyway.
 */
function describe(tool: AnyTool): ToolSpec {
  let inputSchema: Record<string, unknown> = { type: "object", properties: {} };
  if (tool.inputSchema) {
    try {
      inputSchema = z.toJSONSchema(tool.inputSchema as z.ZodType, {
        io: "input",
        unrepresentable: "any",
      }) as Record<string, unknown>;
    } catch (error) {
      console.warn("[mcp] could not describe", tool.name, error);
    }
  }
  return { name: tool.name, description: tool.description, inputSchema };
}

/**
 * Validate a call's arguments the way `chat()` would before running the tool.
 *
 * The flow tools are written to take what a model actually sends and correct it
 * themselves (`coerceData`, `resolveNode`), so this is the outer gate only: it
 * catches a missing required field, and everything shaped-but-wrong is the
 * tool's own business to reject with a better sentence than zod's.
 */
function parseInput(tool: AnyTool, args: unknown): unknown {
  const schema = tool.inputSchema as { parse?: (value: unknown) => unknown } | undefined;
  if (typeof schema?.parse !== "function") return args ?? {};
  return schema.parse(args ?? {});
}

/** Run one tool call and answer it. Never throws: a failure is the tool result. */
async function answer(tools: Map<string, AnyTool>, request: McpRequest): Promise<void> {
  const { id, name } = request;
  try {
    const tool = tools.get(name);
    if (!tool) throw new Error(`no tool '${name}' in this turn`);
    const execute = (tool as { execute?: (args: unknown) => unknown }).execute;
    if (typeof execute !== "function") throw new Error(`tool '${name}' cannot run here`);
    const result = await execute(parseInput(tool, request.arguments));
    await invoke("mcp_tool_result", { id, result: result ?? null, error: null });
  } catch (error) {
    const message = error instanceof z.ZodError
      ? `invalid arguments for ${name}: ${error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`
      : error instanceof Error
        ? error.message
        : String(error);
    await invoke("mcp_tool_result", { id, result: null, error: message }).catch(() => {
      // The app is going away; there is nobody left to tell.
    });
  }
}

export type FlowToolServerOptions = {
  tools: readonly AnyTool[];
  /** Called as each tool call arrives, so the panel can show work happening
   *  while the CLI is still running. */
  onCall?: (name: string) => void;
  /**
   * The turn's abort signal. Closing the session is the stop button: the CLI is
   * a subprocess we cannot interrupt, but the moment the session ends every
   * call in flight fails and every later one is refused, so it can no longer
   * touch the flow whatever it goes on to decide.
   */
  // ponytail: the process itself runs to completion in the background. Killing
  // it needs a child-handle table in `cli_llm.rs`; add that if the wasted
  // tokens or the delay before the binary exits start to matter.
  signal?: AbortSignal;
};

/**
 * Publish `tools` for the duration of `run`.
 *
 * `run` is handed the command a CLI should spawn to reach them, or `undefined`
 * when this build has no MCP server listening (an unsupported platform, or a
 * socket that failed to bind). `undefined` is not an error — it is the signal
 * to fall back to a plain prose turn, which is what the CLI did before this
 * existed.
 */
export async function withFlowToolServer<T>(
  options: FlowToolServerOptions,
  run: (relay: RelayCommand | undefined) => Promise<T>,
): Promise<T> {
  const token = uid();
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]));

  const relay = await invoke<RelayCommand | null>("mcp_session_start", {
    token,
    tools: options.tools.map(describe),
    budget: CALL_BUDGET,
  });
  if (!relay) return run(undefined);

  const key = Symbol(token);
  active = key;
  const unlisten = await listen<McpRequest>("mcp-request", (event) => {
    // A previous turn's listener, still unlistening. The newest session owns
    // the tools; anything else would apply the same write twice.
    if (active !== key) return;
    options.onCall?.(event.payload.name);
    void answer(byName, event.payload);
  });

  // Closing twice is the normal case, not an edge one: an aborted turn closes
  // on the signal and then again in the `finally` when `run` unwinds.
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (active === key) active = undefined;
    unlisten();
    // Fails everything still in flight, so an aborted turn does not leave the
    // CLI waiting on a tool with nowhere to run.
    await invoke("mcp_session_end", { token }).catch(() => {});
  };
  options.signal?.addEventListener("abort", () => void close(), { once: true });

  try {
    return await run(relay);
  } finally {
    await close();
  }
}
