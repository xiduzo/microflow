// The Ask AI conversation's React state.
//
// Not `useChat` from `@tanstack/ai-react`: that hook is built around a client →
// server connection, where a backend route runs the agent loop. Microflow has no
// such route by design — the key is the user's own and the endpoint may be a
// laptop-local Ollama (ADR-0009 D4, ADR-0021). So the loop runs here, in the
// page — `turn-runner.ts` drives `chat()` and the flow tools in-process — and
// this hook only keeps the transcript, the busy flag and the pending card.
//
// One user turn is one `runTurn`. Everything inside it — the model deciding
// to call `get_flow`, then `add_node`, then answering — is that run's business;
// the runner yields transcript updates and this hook applies them.

import { useCallback, useMemo, useRef, useState } from "react";
import type { FlowDocument } from "@microflow/collab";

import { adapterFor } from "./adapter";
import { applyChanges, type PendingChange, type WriteMode } from "./flow-tools";
import { mergePending, runTurn } from "./turn-runner";
import { useLlmProviderStore } from "@/stores/llm-provider";
import { useAskAiStore } from "@/stores/ask-ai";
import { providerModel } from "./models";
import { hostLimitation } from "@/components/flow/nodes/_base/browser-support";
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

export function useAskAi(doc: FlowDocument, writeMode: WriteMode, providerId: string) {
  const [messages, setMessages] = useState<AskAiMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingChange[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // A configuration that was picked and then deleted falls back rather than
  // failing: the panel would otherwise stay dead until the user noticed why.
  //
  // A CLI provider that cannot be handed the flow tools for one run is excluded
  // here and from the picker (see `hostLimitation`): a turn against one answers
  // in prose and silently changes nothing. Better no provider — which the panel
  // says out loud — than one that looks like it worked.
  const provider = useLlmProviderStore((s) => {
    const usable = s.providers.filter(
      (p) => hostLimitation({ kind: "provider", provider: p, surface: "ask-ai" }) === undefined,
    );
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

  /** Accept everything staged by `confirm`-mode turns as one undo step. */
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

      try {
        const turn = runTurn({
          doc,
          adapter: provider ? () => adapterFor(provider, providerModel(provider)) : undefined,
          writeMode,
          history: messages,
          prompt,
          // Read at send time rather than subscribed to: selection changes on
          // every click, and only its value at the moment of asking matters.
          selectedNodeIds: useAskAiStore.getState().selectedNodeIds,
          controller,
        });

        let step = await turn.next();
        while (!step.done) {
          const update = step.value;
          setMessages((prev) =>
            prev.map((m) => (m.id === replyId ? { ...m, ...update } : m)),
          );
          step = await turn.next();
        }

        // Staged changes accumulate across turns until approved or discarded —
        // see `mergePending` for why (replacing lost the previous turn's).
        const staged = step.value;
        if (staged.length > 0) setPending((prev) => mergePending(prev, staged));
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
