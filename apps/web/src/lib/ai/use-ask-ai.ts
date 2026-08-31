// The Ask AI conversation.
//
// Not `useChat` from `@tanstack/ai-react`: that hook is built around a client →
// server connection, where a backend route runs the agent loop. Microflow has no
// such route by design — the key is the user's own and the endpoint may be a
// laptop-local Ollama (ADR-0009 D4, ADR-0021). So the loop runs here, in the
// page, by calling `chat()` directly: it drives tool calls against
// `flow-tools.ts` in-process and streams the answer back.
//
// One user turn is one `chat()` run. Everything inside it — the model deciding
// to call `get_flow`, then `add_node`, then answering — is that run's business;
// this hook keeps the transcript and surfaces which tools ran.

import { useCallback, useMemo, useRef, useState } from "react";
import { chat, EventType, maxIterations } from "@tanstack/ai";
import type { FlowDocument } from "@microflow/collab";

import { adapterFor } from "./adapter";
import { askAiSystemPrompt, currentFlowPrompt } from "./catalog-prompt";
import { applyChanges, createFlowTools, type PendingChange, type WriteMode } from "./flow-tools";
import { useLlmProviderStore } from "@/stores/llm-provider";
import { useAskAiStore } from "@/stores/ask-ai";
import { providerModel } from "./models";
import { isCliProvider } from "./cli-providers";
import { uid } from "@/lib/uid";

/** A turn in the transcript. `tools` names what ran during an assistant turn, so
 *  the user can see the assistant worked rather than only that it replied. */
export type AskAiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools?: string[];
  error?: boolean;
};

/**
 * How many model↔tool round trips one turn may take.
 *
 * "Add a button that toggles an LED" is realistically get_flow → add_node →
 * add_node → connect → answer, and a model that mis-names a handle spends
 * another on the correction. Twelve leaves room for that without letting a
 * confused small model loop against the user's own endpoint indefinitely.
 */
const MAX_ITERATIONS = 12;

export function useAskAi(doc: FlowDocument, writeMode: WriteMode, providerId: string) {
  const [messages, setMessages] = useState<AskAiMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingChange[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // A configuration that was picked and then deleted falls back rather than
  // failing: the panel would otherwise stay dead until the user noticed why.
  //
  // Local CLI providers are excluded here and from the picker: they cannot call
  // our flow tools (see `isCliProvider`), so an Ask AI turn against one answers
  // in prose and silently changes nothing. Better no provider — which the panel
  // says out loud — than one that looks like it worked.
  const provider = useLlmProviderStore((s) => {
    const usable = s.providers.filter((p) => !isCliProvider(p));
    return (
      usable.find((p) => p.id === providerId) ?? usable.find((p) => p.isDefault) ?? usable[0]
    );
  });

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setPending([]);
    setBusy(false);
  }, []);

  /** Accept every staged change from a `confirm`-mode turn as one undo step. */
  const acceptPending = useCallback(() => {
    applyChanges(doc, pending);
    setPending([]);
  }, [doc, pending]);

  const rejectPending = useCallback(() => setPending([]), []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setBusy(false);
  }, []);

  const send = useCallback(
    async (prompt: string) => {
      if (busy || prompt.trim().length === 0) return;
      if (!provider) {
        setMessages((prev) => [
          ...prev,
          { id: uid(), role: "user", content: prompt },
          {
            id: uid(),
            role: "assistant",
            content:
              "No LLM provider is configured yet. Add one under Configuration → LLM — Ollama on this machine works, and so does any OpenAI-compatible endpoint.",
            error: true,
          },
        ]);
        return;
      }

      // Our own failure notices are UI, not something the model said — feeding
      // them back as assistant turns would have it apologising for our errors.
      const history = messages.filter((m) => !m.error && m.content.length > 0);
      const userMessage: AskAiMessage = { id: uid(), role: "user", content: prompt };
      const replyId = uid();
      setMessages((prev) => [
        ...prev,
        userMessage,
        { id: replyId, role: "assistant", content: "" },
      ]);
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;

      // Staged changes accumulate for the whole turn, so `confirm` mode shows
      // one card for "add two nodes and wire them", not three.
      const staged: PendingChange[] = [];
      const tools = createFlowTools(doc, {
        mode: writeMode,
        stage: (change) => staged.push(change),
      });

      const patch = (update: Partial<AskAiMessage>) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === replyId ? { ...m, ...update } : m)),
        );
      };

      try {
        const adapter = await adapterFor(provider, providerModel(provider));
        const stream = chat({
          adapter,
          systemPrompts: [
            askAiSystemPrompt(writeMode !== "read-only"),
            // Read at send time rather than subscribed to: selection changes on
            // every click, and only its value at the moment of asking matters.
            currentFlowPrompt(doc, useAskAiStore.getState().selectedNodeIds),
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
            patch({ content: text });
          }
          if (chunk.type === EventType.TOOL_CALL_START) {
            const name = chunk.toolCallName ?? chunk.toolName;
            if (name) {
              used.push(name);
              patch({ tools: [...used] });
            }
          }
        }

        if (controller.signal.aborted) return;
        patch({ content: text, tools: used.length > 0 ? used : undefined });
        if (staged.length > 0) setPending(staged);
      } catch (error) {
        if (controller.signal.aborted) return;
        patch({
          content: error instanceof Error ? error.message : String(error),
          error: true,
        });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setBusy(false);
      }
    },
    [busy, doc, messages, provider, writeMode],
  );

  return useMemo(
    () => ({
      messages,
      busy,
      pending,
      provider,
      send,
      stop,
      reset,
      acceptPending,
      rejectPending,
    }),
    [messages, busy, pending, provider, send, stop, reset, acceptPending, rejectPending],
  );
}
