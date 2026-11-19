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
// `tools/list`, holds every call the host sends up to the schema it described,
// answers it, and owns the session's lifetime. It reaches the host through the
// `AgentCliPort` it is given (`agent-cli-port.ts`), never through Tauri directly.
//
// ## Why the session is scoped to a callback
//
// `withFlowToolServer` opens the session, runs its callback, and closes in a
// `finally`. There is no `open()` for a caller to forget to pair — an aborted
// turn, a thrown adapter, a rejected spawn, a host that will not let it listen
// for tool calls all land in the same close. That
// matters more than it looks: while a session is open, any process this user
// runs that guesses the token could edit the flow. Its lifetime *is* the
// security boundary, so it is not left to a caller's discipline.
//
// ## Why one session at a time
//
// The host broadcasts tool calls (a Tauri event, by name), so two live
// subscribers would both answer the same call — and both would run the write.
// The host drops the second reply, but the second *write* would already have
// landed: a node added twice. `active` makes the newest session the only one
// that acts, which is also what the Rust side does with the token.

import { z } from "zod";
import type { AnyTool } from "@tanstack/ai";

import { uid } from "@/lib/uid";

import type { AgentCliPort, RelayCommand, ToolCall, ToolSpec } from "./agent-cli-port";

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

/** The session that may answer a tool call right now. */
let active: symbol | undefined;

/** One tool as a session publishes it. */
type Published = {
  /** What `tools/list` shows the CLI. */
  spec: ToolSpec;
  /** Checks a call's arguments against `spec.inputSchema`. */
  accepts: z.ZodType;
  /** The tool's own `execute`, when it has one to run in the webview. */
  execute: ((args: unknown) => unknown) | undefined;
};

/**
 * Publish one tool: what the CLI is shown, and the gate its calls go through.
 *
 * Both come from one object, the JSON Schema the tool arrives with, so what the
 * CLI is shown is what its call is validated against. That schema is never
 * written by hand: `chat()` derives it from the tool's own zod schema before it
 * hands the tools to an adapter, which is how every tool gets here.
 *
 * The gate is `z.fromJSONSchema`: zod is the one schema library the app
 * already ships, and it reads back every construct its own conversion writes
 * (`type`, `properties`, `required`, `anyOf`, `enum`, `additionalProperties`,
 * typed `propertyNames`, and the rest `mcp-bridge.test.ts` goes through one by
 * one). It is not a general JSON Schema validator, in two ways:
 *
 * - A schema it has no check for (`not`, `if`/`then`/`else`), or one that is
 *   not JSON Schema at all, fails the publish: a tool the CLI could call
 *   unchecked is not published quietly.
 * - Three shapes it accepts and does not enforce: object keywords on a schema
 *   with no `type: "object"`, `required` with no `properties`, and
 *   `propertyNames` that is untyped or sits beside `properties`. A schema
 *   derived from zod has none of them.
 */
function publish(tool: AnyTool): Published {
  const inputSchema: unknown = tool.inputSchema ?? { type: "object", properties: {} };
  const execute = (tool as { execute?: (args: unknown) => unknown }).execute;
  try {
    if (typeof inputSchema !== "object" || inputSchema === null || "~standard" in inputSchema) {
      throw new Error("its input schema is not JSON Schema");
    }
    return {
      spec: {
        name: tool.name,
        description: tool.description,
        inputSchema: inputSchema as Record<string, unknown>,
      },
      accepts: z.fromJSONSchema(inputSchema as Parameters<typeof z.fromJSONSchema>[0]),
      execute: typeof execute === "function" ? execute : undefined,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot publish the tool '${tool.name}': ${reason}`);
  }
}

/** The value at `path` inside a call's arguments. */
function valueAt(args: unknown, path: readonly PropertyKey[]): unknown {
  return path.reduce<unknown>(
    (value, key) => (value as Record<PropertyKey, unknown> | null | undefined)?.[key],
    args,
  );
}

/** The JSON type of a value the CLI sent, in the schema's own words. */
function jsonType(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

/** zod's names for two types, in the words of the schema the CLI was shown. */
const SCHEMA_WORD: Record<string, string> = { record: "object", int: "integer" };

/**
 * The types that would have been accepted where `issue` is, when the issue is
 * that the value has the wrong type. For `anyOf` that is one type per branch,
 * and only when every branch turned the value down for its type: a branch that
 * failed deeper in means the type was fine.
 */
function acceptedTypes(issue: z.core.$ZodIssue): string[] {
  if (issue.code === "invalid_type") return [SCHEMA_WORD[issue.expected] ?? issue.expected];
  if (issue.code !== "invalid_union") return [];
  const perBranch = issue.errors.map((branch) =>
    branch.flatMap((inner) => (inner.path.length === 0 ? acceptedTypes(inner) : [])),
  );
  return perBranch.some((types) => types.length === 0) ? [] : [...new Set(perBranch.flat())];
}

/**
 * Why a call's arguments were turned down, as one sentence a model can act on:
 * every problem, each under the name of the field it is about.
 */
function rejection(name: string, args: unknown, issues: readonly z.core.$ZodIssue[]): string {
  const problems = issues.map((issue) => {
    const field = issue.path.join(".");
    const value = valueAt(args, issue.path);
    // A field that is not there is missing, whatever check noticed.
    if (field && value === undefined) return `${field} is required`;
    const accepted = acceptedTypes(issue);
    const problem =
      accepted.length > 0
        ? `expected ${accepted.join(" or ")}, received ${jsonType(value)}`
        : issue.message;
    return field ? `${field}: ${problem}` : problem;
  });
  return `invalid arguments for ${name}: ${problems.join("; ")}`;
}

/** Run one tool call and answer it. Never throws: a failure is the tool result. */
async function answer(
  port: AgentCliPort,
  tools: Map<string, Published>,
  call: ToolCall,
): Promise<void> {
  const { id, name } = call;
  try {
    const tool = tools.get(name);
    // The host refuses a name outside the roster before it gets here.
    if (!tool) throw new Error(`no tool '${name}' in this turn`);
    if (!tool.execute) throw new Error(`tool '${name}' cannot run here`);
    // The gate: nothing runs on arguments the published schema does not accept.
    // The tool is handed what the CLI sent, not a parsed copy of it.
    const args = call.arguments ?? {};
    const checked = tool.accepts.safeParse(args);
    if (!checked.success) throw new Error(rejection(name, args, checked.error.issues));
    const result = await tool.execute(args);
    await port.answerToolCall(id, { result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await port.answerToolCall(id, { error: message }).catch(() => {
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
   * The turn's abort signal. When it aborts the session closes at once: every
   * call in flight fails and every later one is refused, so nothing the CLI
   * does from then on reaches the flow. The same signal ends the CLI's process,
   * which is the run's business (`AgentCliPort.run`); the session is closed
   * here as well because a process takes a moment to end and must not edit the
   * flow in that moment.
   *
   * A signal that has aborted before the CLI is started means it is never
   * started: `withFlowToolServer` rejects with the signal's reason, with no
   * session left open.
   */
  signal?: AbortSignal;
};

/**
 * Publish `tools` on `port`'s host for the duration of `run`.
 *
 * `run` is handed the command a CLI should spawn to reach them, or `undefined`
 * when the host has no MCP server listening (an unsupported platform, or a
 * socket that failed to bind). `undefined` is not an error — it is the signal
 * to run a plain prose turn instead.
 */
export async function withFlowToolServer<T>(
  port: AgentCliPort,
  options: FlowToolServerOptions,
  run: (relay: RelayCommand | undefined) => Promise<T>,
): Promise<T> {
  // A turn that is already stopped starts nothing. `run` is what starts the
  // CLI, and a run for a turn nobody is waiting on is paid for all the same.
  const start = (relay: RelayCommand | undefined) => {
    options.signal?.throwIfAborted();
    return run(relay);
  };
  options.signal?.throwIfAborted();

  const token = uid();
  // Before anything is opened: a tool that cannot be published fails the turn
  // with no session to clean up.
  const published = options.tools.map(publish);
  const byName = new Map(published.map((tool) => [tool.spec.name, tool]));

  const relay = await port.openSession({
    token,
    tools: published.map((tool) => tool.spec),
    budget: CALL_BUDGET,
  });
  if (!relay) return start(undefined);

  const key = Symbol(token);
  active = key;
  /** Stops listening for tool calls, once there is a subscription to stop. */
  let unlisten = () => {};

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
    await port.closeSession(token).catch(() => {});
  };

  // The session is open from here on, so everything after this runs under the
  // `finally` that closes it: the subscription too, which the host can refuse.
  try {
    unlisten = await port.onToolCall((call) => {
      // A previous turn's subscriber, still unsubscribing. The newest session
      // owns the tools; anything else would apply the same write twice.
      if (active !== key) return;
      options.onCall?.(call.name);
      void answer(port, byName, call);
    });
    options.signal?.addEventListener("abort", () => void close(), { once: true });

    // An abort that landed while the session was opening fired before anyone
    // was listening for it. `start` turns it down here, and the `finally`
    // closes a session no process was ever given the token for.
    return await start(relay);
  } finally {
    await close();
  }
}
