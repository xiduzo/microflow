// One Ask AI turn, as a plain async generator.
//
// `use-ask-ai.ts` owns React state; this owns everything between "the user hit
// send" and "the reply is final": filtering our own error notices out of the
// history, driving `chat()` against the flow tools, mapping the stream to
// transcript updates, and collecting what `confirm` mode staged. No React in
// here, which is what makes the loop testable against a fake adapter.
//
// ADR-0021: the adapter (`adapterFor` / `AnyTextAdapter`) is the one transport
// seam, and this module sits behind it — `adapter` is taken as a lazy resolver
// so a resolution failure is this turn's error like any other, not a new seam.

import { chat, EventType, maxIterations } from "@tanstack/ai";
import type { AnyTextAdapter } from "@tanstack/ai";
import type { FlowDocument } from "@microflow/collab";

import { askAiSystemPrompt, currentFlowPrompt } from "./catalog-prompt";
import { createFlowTools, type PendingChange, type WriteMode } from "./flow-tools";

/**
 * How many model↔tool round trips one turn may take.
 *
 * "Add a button that toggles an LED" is realistically get_flow → add_node →
 * add_node → connect → answer, and a model that mis-names a handle spends
 * another on the correction. Twelve leaves room for that without letting a
 * confused small model loop against the user's own endpoint indefinitely.
 */
export const MAX_ITERATIONS = 12;

export const NO_PROVIDER_MESSAGE =
  "No LLM provider is configured yet. Add one under Configuration → LLM — Ollama on this machine works, and so does any OpenAI-compatible endpoint.";

/** A patch to the turn's reply message: the text so far, the tools run so far,
 *  or the failure that ended it. Shaped so the hook can apply it verbatim. */
export type TurnUpdate = { content?: string; tools?: string[]; error?: boolean };

/** What the runner needs of a transcript entry. `error` marks our own failure
 *  notices — UI, not something the model said, so they are filtered out of the
 *  history sent to the adapter (the model would apologise for our errors). */
export type TurnMessage = { role: "user" | "assistant"; content: string; error?: boolean };

export type TurnOptions = {
  doc: FlowDocument;
  /**
   * Lazily resolves the ADR-0021 adapter seam (`() => adapterFor(...)`), or
   * `undefined` when no usable provider is configured — the runner answers
   * that with {@link NO_PROVIDER_MESSAGE} rather than making every caller
   * handle it.
   */
  adapter: (() => Promise<AnyTextAdapter>) | undefined;
  writeMode: WriteMode;
  history: TurnMessage[];
  prompt: string;
  selectedNodeIds: string[];
  controller: AbortController;
};

/**
 * The hook's merge for what a turn staged: append, in staging order.
 *
 * Pending entries are keyed by a fresh uid and carry opaque apply-thunks —
 * there is no per-node key to dedupe on. Appending preserves the order the
 * model staged them in, and `applyChanges` runs them in that order inside one
 * transaction, so when two staged changes touch the same node the later one
 * lands last and wins. Replacing instead of appending was the bug: a second
 * `confirm` turn silently discarded the first turn's unapproved changes.
 */
export function mergePending(prev: PendingChange[], staged: PendingChange[]): PendingChange[] {
  return [...prev, ...staged];
}

/**
 * Run one turn. Yields transcript updates as the stream produces them and
 * returns what `confirm` mode staged — empty on error or abort, where nothing
 * should reach the pending card. Never throws: every failure becomes an
 * `error: true` update, except an abort, which ends the turn silently with the
 * partial text as yielded.
 */
export async function* runTurn(
  options: TurnOptions,
): AsyncGenerator<TurnUpdate, PendingChange[]> {
  const { doc, adapter, writeMode, prompt, controller } = options;

  if (!adapter) {
    yield { content: NO_PROVIDER_MESSAGE, error: true };
    return [];
  }

  const history = options.history.filter((m) => !m.error && m.content.length > 0);

  // Staged changes accumulate for the whole turn, so `confirm` mode shows
  // one card for "add two nodes and wire them", not three.
  const staged: PendingChange[] = [];
  const tools = createFlowTools(doc, {
    mode: writeMode,
    stage: (change) => staged.push(change),
  });

  try {
    const stream = chat({
      adapter: await adapter(),
      systemPrompts: [
        askAiSystemPrompt(writeMode !== "read-only"),
        currentFlowPrompt(doc, options.selectedNodeIds),
      ],
      messages: [
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: prompt },
      ],
      tools,
      abortController: controller,
      agentLoopStrategy: maxIterations(MAX_ITERATIONS),
      stream: true,
    });

    let text = "";
    const used: string[] = [];
    for await (const chunk of stream) {
      if (chunk.type === EventType.RUN_ERROR) {
        throw new Error(chunk.message || "the model returned an error");
      }
      if (chunk.type === EventType.TEXT_MESSAGE_CONTENT && chunk.delta) {
        text += chunk.delta;
        yield { content: text };
      }
      if (chunk.type === EventType.TOOL_CALL_START) {
        const name = chunk.toolCallName ?? chunk.toolName;
        if (name) {
          used.push(name);
          yield { tools: [...used] };
        }
      }
    }

    if (controller.signal.aborted) return [];
    yield { content: text, tools: used.length > 0 ? used : undefined };
    return staged;
  } catch (error) {
    if (controller.signal.aborted) return [];
    yield {
      content: error instanceof Error ? error.message : String(error),
      error: true,
    };
    return [];
  }
}
