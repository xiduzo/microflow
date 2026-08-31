// A TanStack AI text adapter backed by a local CLI process.
//
// `adapterFor` is the one seam every AI surface resolves through — the `Llm`
// node's transport and Ask AI both take whatever it returns — so a CLI provider
// only has to be an `AnyTextAdapter` to work everywhere an HTTP provider does.
// That is what this is: `chatStream` spawns the binary through
// `llm_cli_generate` and reports its stdout as one assistant message.
//
// TanStack AI has no adapter for this (its own docs point at "a future
// `claudeCode()`" harness adapter), and cannot: running a process is a host
// capability, and the only host we have with one is the desktop app.
//
// ## What a CLI provider cannot do
//
// **Tools.** These CLIs have their own tools and no wire format for ours, so
// nothing here ever yields `TOOL_CALL_*`. Ask AI's loop therefore gets prose
// where it wanted `add_node`, and its writes never fire — which is why the Ask
// AI panel steers away from CLI providers rather than silently under-delivering.
// The `Llm` node and the config console, which only want text, are unaffected.
//
// **Streaming.** One invoke, one string (see `llm_cli_generate`). The stream
// below is a stream of one, so `onDelta` fires once with the whole answer.

import { EventType } from "@tanstack/ai";
import type { AnyTextAdapter } from "@tanstack/ai";

import { cliProvider, takesSystemFlag, type CliProvider } from "./cli-providers";

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

class CliTextAdapter {
  readonly kind = "text" as const;
  readonly name: string;

  constructor(
    private readonly cli: CliProvider,
    readonly model: string,
  ) {
    this.name = cli.id;
  }

  private async run(options: {
    messages: ReadonlyArray<{ role: string; content: unknown }>;
    systemPrompts?: ReadonlyArray<string | { content?: string }>;
  }): Promise<string> {
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
        ...(this.cli.promptAsArg ? [prompt] : []),
      ],
      prompt: this.cli.promptAsArg ? "" : prompt,
    });

    if (!response.success) throw new Error(response.error);
    const stdout = typeof response.data === "string" ? response.data : String(response.data ?? "");
    return clean(this.cli, stdout);
  }

  async *chatStream(options: unknown): AsyncIterable<unknown> {
    const chatOptions = options as unknown as {
      messages: ReadonlyArray<{ role: string; content: unknown }>;
      systemPrompts?: ReadonlyArray<string | { content?: string }>;
      runId?: string;
      threadId?: string;
    };
    const runId = chatOptions.runId ?? `run-${Date.now()}`;
    const threadId = chatOptions.threadId ?? `thread-${Date.now()}`;
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const at = () => Date.now();

    const emit = (chunk: Record<string, unknown>) => chunk;

    try {
      const text = await this.run(chatOptions);

      yield emit({ type: EventType.RUN_STARTED, runId, threadId, model: this.model, timestamp: at() });
      yield emit({
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        model: this.model,
        timestamp: at(),
        role: "assistant",
      });
      yield emit({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        model: this.model,
        timestamp: at(),
        delta: text,
        content: text,
      });
      yield emit({
        type: EventType.TEXT_MESSAGE_END,
        messageId,
        model: this.model,
        timestamp: at(),
      });
      yield emit({
        type: EventType.RUN_FINISHED,
        runId,
        threadId,
        model: this.model,
        timestamp: at(),
        finishReason: "stop",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield emit({
        type: EventType.RUN_ERROR,
        model: this.model,
        timestamp: at(),
        message,
        code: "cli_error",
        error: { message, code: "cli_error" },
      });
    }
  }

  async structuredOutput(options: unknown): Promise<{ data: unknown; rawText: string }> {
    // No CLI here has a JSON-schema mode, so this is the honest fallback: ask
    // for the shape in words and parse what comes back. Nothing in Microflow
    // asks a provider for structured output today — this exists so the adapter
    // satisfies the interface rather than throwing halfway through a run.
    const { chatOptions, outputSchema } = options as unknown as {
      chatOptions: Parameters<CliTextAdapter["run"]>[0] & {
        systemPrompts?: ReadonlyArray<string | { content?: string }>;
      };
      outputSchema: unknown;
    };
    const rawText = await this.run({
      ...chatOptions,
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
