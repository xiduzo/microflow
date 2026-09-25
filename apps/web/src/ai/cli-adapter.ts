// A TanStack AI text adapter backed by a local CLI process.
//
// `adapterFor` is the one seam every AI surface resolves through — the `Llm`
// node's transport and Ask AI both take whatever it returns — so a CLI provider
// only has to be an `AnyTextAdapter` to work everywhere an HTTP provider does.
// That is what this is: `chatStream` spawns the binary through
// `llm_cli_generate` and reports its stdout as one assistant message.
//
// TanStack AI has no adapter for this (its own docs point at "a future
// `claudeCode()` harness adapter"), and cannot: running a process is a host
// capability, and the only host we have with one is the desktop app.
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
// ## Streaming
//
// One invoke, one string (see `llm_cli_generate`). The text arrives whole at
// the end; the tool events above are the only thing that streams.

import { EventType } from "@tanstack/ai";
import type { AnyTextAdapter, AnyTool } from "@tanstack/ai";

import { cliProvider, takesSystemFlag, type CliProvider } from "./cli-providers";
import { withFlowToolServer, type RelayCommand } from "./mcp-bridge";

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
  abortSignal?: AbortSignal;
};

class CliTextAdapter {
  readonly kind = "text" as const;
  readonly name: string;

  constructor(
    private readonly cli: CliProvider,
    readonly model: string,
  ) {
    this.name = cli.id;
  }

  /** Run the binary once. `mcp` is the server the CLI should call our flow
   *  tools on, when there is one to give it. */
  private async run(
    options: RunOptions,
    mcp?: { relay: RelayCommand; tools: string[] },
  ): Promise<string> {
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

    // Imported here rather than at module scope: `lib/ipc` pulls in the Tauri
    // API, and this module is reachable from the web build's provider list.
    const { invokeCommand } = await import("@/lib/ipc");
    const response = await invokeCommand<
      { type: "llm_cli_generate"; bin: string; args: string[]; prompt: string },
      Record<string, unknown>
    >({
      type: "llm_cli_generate",
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
      prompt: this.cli.promptAsArg ? "" : prompt,
    });

    if (!response.success) throw new Error(response.error);
    const stdout = typeof response.data === "string" ? response.data : String(response.data ?? "");
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
    const answer =
      this.cli.mcpArgs && names.length > 0
        ? withFlowToolServer(
            {
              tools,
              signal: options.abortSignal,
              onCall: (name) => {
                calls.push(name);
                bump();
              },
            },
            (relay) =>
              this.run(options, relay ? { relay, tools: names } : undefined),
          )
        : this.run(options);

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
    const rawText = await this.run({
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

/** Build an adapter for a CLI provider, or `undefined` if `id` names no CLI. */
export function cliAdapterFor(id: string, model: string): AnyTextAdapter | undefined {
  const cli = cliProvider(id);
  if (!cli) return undefined;
  return new CliTextAdapter(cli, model) as unknown as AnyTextAdapter;
}
