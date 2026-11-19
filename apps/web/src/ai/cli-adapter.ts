// A TanStack AI text adapter backed by a local CLI process.
//
// `adapterFor` is the one seam every AI surface resolves through — the `Llm`
// node's transport and Ask AI both take whatever it returns — so a CLI provider
// only has to be an `AnyTextAdapter` to work everywhere an HTTP provider does.
// That is what this is: `chatStream` runs the binary and reports its stdout as
// one assistant message.
//
// TanStack AI has no adapter for this (its own docs point at "a future
// `claudeCode()` harness adapter"), and cannot: running a process is a host
// capability, and the only host we have with one is the desktop app.
//
// ## The host
//
// The process and the MCP server it calls back into are reached through an
// `AgentCliPort` (`agent-cli-port.ts`), which this adapter is constructed with.
// Everything in this file is above that seam — the argument vector, the prompt,
// what stdout becomes, the order of the events — so it runs against the scripted
// host in `cli-adapter.test.ts` as it runs against the desktop one.
//
// ## Tools
//
// `chat()` hands every adapter the turn's `tools` and expects it to put them on
// the wire and read tool calls back off it. A CLI has no such wire — it has its
// own agent loop, and its own tool protocol, which is MCP. So the tools are not
// serialised into the prompt here; they are *published* on the desktop app's
// MCP server for the length of this call, and the CLI is spawned pointed at
// them (`mcp-bridge.ts`, `src-tauri/src/mcp/`). The CLI then runs its own loop
// against the same `createFlowTools` tool objects the HTTP path calls directly.
//
// Which means `chatStream` yields `TOOL_CALL_*` for work it did not itself
// perform: the events come from the bridge as the calls arrive, so the panel
// shows tools running while the process is still going. It is a report, not a
// request — nothing here waits on a tool result, because the CLI already did.
//
// A CLI with no `mcpArgs` gets no session at all and answers in prose, which is
// what `hostLimitation` warns about before the user picks one for Ask AI.
//
// ## Stop
//
// `chat()` hands the turn's abort signal to an adapter as `request.signal`.
//
// A turn stopped before its CLI has started never starts it: `run` checks the
// signal first, on every path.
//
// A turn stopped while its CLI is running ends the process: the signal goes
// with the run to the port, and the host ends the process and everything it
// started (`AgentCliPort.run`). The same signal goes to the bridge, which
// closes the turn's session (ADR-0024). Both happen at the stop, so a stopped
// turn spends no more tokens and reaches the flow no more. This holds for every
// run: with a session or without, for a chat, a structured answer or an `Llm`
// node's generation.
//
// The stream of a stopped run ends in `RUN_ERROR` carrying the signal's reason,
// and never in text. Whoever stopped the turn decides what to show for that;
// `turn-runner.ts` and `llm-performer.ts` both show nothing.
//
// ## Streaming
//
// One run, one string (see `AgentCliPort.run`). The text arrives whole at the
// end; the tool events above are the only thing that streams.

import { EventType } from "@tanstack/ai";
import type { AnyTextAdapter, AnyTool } from "@tanstack/ai";

import type { AgentCliPort, RelayCommand } from "./agent-cli-port";
import { cliProvider, takesSystemFlag, type CliProvider } from "./cli-providers";
import { withFlowToolServer } from "./mcp-bridge";

/** Resolves the port a CLI adapter runs on. Lazy, so the desktop adapter (and
 *  the Tauri API behind it) loads only when a CLI is actually run. */
export type AgentCliPortResolver = () => Promise<AgentCliPort>;

const desktopPort: AgentCliPortResolver = async () =>
  (await import("./tauri-agent-cli")).tauriAgentCli;

/** The MCP server name Rust registers under. Mirrors `mcp::SERVER_NAME`; the
 *  CLIs' own permission flags are written as `mcp__<server>__<tool>`, so this
 *  is wire contract, not a label. */
const SERVER_NAME = "microflow";

/** Flatten a TanStack message list to the single prompt a print-mode CLI takes.
 *
 *  These CLIs own their own session state and expose no way to hand them a
 *  transcript, so a multi-turn conversation is replayed as labelled text. Good
 *  enough for the one- and two-turn use this has; a CLI's own `--continue` is
 *  the real answer if threads ever matter here. */
function flatten(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
  const text = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          part && typeof part === "object" && "text" in part ? String(part.text) : "",
        )
        .join("");
    }
    return "";
  };

  if (messages.length === 1) return text(messages[0].content);
  return messages
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${text(message.content)}`)
    .join("\n\n");
}

// The `TextAdapter` interface, implemented directly rather than by extending
// `BaseTextAdapter`: that base class exists to hold provider SDK config and
// seven generic parameters resolved by a provider function, none of which a
// process invocation has. `chat()` only ever reads `kind`, `name`, `model`,
// `chatStream` and `structuredOutput`.
/** Terminal control sequences. These CLIs colour their output whether or not
 *  a TTY is attached, and escape codes have no business in a chat message or in
 *  a `value` handle feeding a Monitor node. */
const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;

/** stdout as an answer: no colour codes, no CLI chrome, no trailing blank. */
function clean(cli: CliProvider, stdout: string): string {
  const plain = stdout.replace(ANSI, "");
  return (cli.stripBanner ? cli.stripBanner(plain) : plain).trim();
}

type RunOptions = {
  messages: ReadonlyArray<{ role: string; content: unknown }>;
  systemPrompts?: ReadonlyArray<string | { content?: string }>;
  tools?: ReadonlyArray<AnyTool>;
  /** Where `chat()` puts the turn's abort signal: it is written for adapters
   *  that pass `request` on to `fetch`. */
  request?: { signal?: AbortSignal | null };
};

class CliTextAdapter {
  readonly kind = "text" as const;
  readonly name: string;

  constructor(
    private readonly cli: CliProvider,
    readonly model: string,
    private readonly port: AgentCliPortResolver,
  ) {
    this.name = cli.id;
  }

  /** Run the binary once. `mcp` is the server the CLI should call our flow
   *  tools on, when there is one to give it. */
  private async run(
    port: AgentCliPort,
    options: RunOptions,
    mcp?: { relay: RelayCommand; tools: string[] },
  ): Promise<string> {
    // The one place a CLI is started, so the one place a stopped turn is turned
    // down and the one place a run is given its turn's signal: with a session
    // or without, for a chat or a structured answer. A run nobody is waiting
    // for is paid for all the same.
    options.request?.signal?.throwIfAborted();

    const system =
      (options.systemPrompts ?? [])
        .map((entry) => (typeof entry === "string" ? entry : (entry.content ?? "")))
        .filter(Boolean)
        .join("\n\n") || null;

    // Every CLI takes the prompt on stdin; only some take the system prompt as
    // a flag. The rest get it folded in, which is the best a print-mode CLI
    // with no such flag can do.
    const inline = system && !takesSystemFlag(this.cli);
    const prompt = inline ? `${system}\n\n${flatten(options.messages)}` : flatten(options.messages);

    const stdout = await port.run({
      bin: this.cli.id,
      // A CLI that takes the prompt as an argument gets it appended and an
      // empty stdin; every other one gets it on stdin and no prompt in argv.
      args: [
        ...this.cli.args(this.model, inline ? null : system),
        ...(mcp
          ? (this.cli.mcpArgs?.({ relay: mcp.relay, server: SERVER_NAME, tools: mcp.tools }) ?? [])
          : []),
        ...(this.cli.promptAsArg ? [prompt] : []),
      ],
      stdin: this.cli.promptAsArg ? "" : prompt,
      // The run lives as long as the turn does: a stop ends the process.
      signal: options.request?.signal ?? undefined,
    });
    return clean(this.cli, stdout);
  }

  /**
   * Run the CLI, publishing this turn's flow tools to it if it can take them.
   *
   * Returns the answer plus a live queue of the tool names it called, which
   * `chatStream` drains into `TOOL_CALL_*` events while the process runs.
   */
  private start(options: RunOptions): { answer: Promise<string>; calls: string[]; done: Promise<void>; wake: () => Promise<void> } {
    const calls: string[] = [];
    let notify: (() => void) | undefined;
    const bump = () => {
      const resolve = notify;
      notify = undefined;
      resolve?.();
    };

    const tools = options.tools ?? [];
    const names = tools.map((tool) => tool.name);
    // No `mcpArgs` (or no tools this turn) means no session: publishing tools a
    // CLI was never told how to reach would open the door for the length of the
    // run and get nothing for it.
    const answer = this.port().then((port) =>
      this.cli.mcpArgs && names.length > 0
        ? withFlowToolServer(
            port,
            {
              tools,
              signal: options.request?.signal ?? undefined,
              onCall: (name) => {
                calls.push(name);
                bump();
              },
            },
            (relay) => this.run(port, options, relay ? { relay, tools: names } : undefined),
          )
        : this.run(port, options),
    );

    // `done` never rejects: the failure is `answer`'s to report, and an
    // unhandled rejection here would surface as a console error instead.
    const done = answer.then(
      () => bump(),
      () => bump(),
    );
    return { answer, calls, done, wake: () => new Promise<void>((resolve) => { notify = resolve; }) };
  }

  async *chatStream(options: unknown): AsyncIterable<unknown> {
    const chatOptions = options as RunOptions & { runId?: string; threadId?: string };
    const runId = chatOptions.runId ?? `run-${Date.now()}`;
    const threadId = chatOptions.threadId ?? `thread-${Date.now()}`;
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const at = () => Date.now();

    yield { type: EventType.RUN_STARTED, runId, threadId, model: this.model, timestamp: at() };

    const { answer, calls, done, wake } = this.start(chatOptions);
    let finished = false;
    void done.then(() => {
      finished = true;
    });

    try {
      // Report tool calls as the bridge sees them, so the panel shows the CLI
      // working rather than a spinner for however long its loop takes.
      let index = 0;
      for (;;) {
        while (index < calls.length) {
          const toolCallName = calls[index];
          const toolCallId = `${messageId}-tool-${index}`;
          index += 1;
          yield { type: EventType.TOOL_CALL_START, toolCallId, toolCallName, toolName: toolCallName, timestamp: at() };
          // The CLI already ran it and already has the result; the pair exists
          // so a stream reader sees a complete call, not a dangling start.
          yield { type: EventType.TOOL_CALL_END, toolCallId, timestamp: at() };
        }
        if (finished) break;
        await Promise.race([wake(), done]);
      }

      const text = await answer;

      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        model: this.model,
        timestamp: at(),
        role: "assistant",
      };
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        model: this.model,
        timestamp: at(),
        delta: text,
        content: text,
      };
      yield { type: EventType.TEXT_MESSAGE_END, messageId, model: this.model, timestamp: at() };
      yield {
        type: EventType.RUN_FINISHED,
        runId,
        threadId,
        model: this.model,
        timestamp: at(),
        finishReason: "stop",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield {
        type: EventType.RUN_ERROR,
        model: this.model,
        timestamp: at(),
        message,
        code: "cli_error",
        error: { message, code: "cli_error" },
      };
    }
  }

  async structuredOutput(options: unknown): Promise<{ data: unknown; rawText: string }> {
    // No CLI here has a JSON-schema mode, so this is the honest fallback: ask
    // for the shape in words and parse what comes back. Nothing in Microflow
    // asks a provider for structured output today — this exists so the adapter
    // satisfies the interface rather than throwing halfway through a run.
    const { chatOptions, outputSchema } = options as unknown as {
      chatOptions: RunOptions;
      outputSchema: unknown;
    };
    const rawText = await this.run(await this.port(), {
      ...chatOptions,
      // Tools are for `chatStream`; a structured answer wants no side effects.
      tools: undefined,
      systemPrompts: [
        ...(chatOptions.systemPrompts ?? []),
        `Reply with JSON matching this schema and nothing else: ${JSON.stringify(outputSchema)}`,
      ],
    });

    // CLIs like to wrap JSON in a fence even when told not to.
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(rawText);
    const body = (fenced?.[1] ?? rawText).trim();
    try {
      return { data: JSON.parse(body), rawText };
    } catch {
      throw new Error(`${this.cli.id} did not return JSON: ${body.slice(0, 200)}`);
    }
  }
}

/**
 * Build an adapter for a CLI provider, or `undefined` if `id` names no CLI.
 *
 * `port` is the host the CLI runs on: the desktop app unless told otherwise.
 */
export function cliAdapterFor(
  id: string,
  model: string,
  port: AgentCliPortResolver = desktopPort,
): AnyTextAdapter | undefined {
  const cli = cliProvider(id);
  if (!cli) return undefined;
  return new CliTextAdapter(cli, model, port) as unknown as AnyTextAdapter;
}
