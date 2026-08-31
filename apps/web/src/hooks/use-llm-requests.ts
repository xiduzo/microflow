import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { CloudRequest } from "@/lib/bindings/CloudRequest";
import { useListen } from "@/lib/ipc";
import { isDesktop } from "@/lib/platform";
import { useLlmProviderStore } from "@/stores/llm-provider";
import type { EmitOf } from "@/components/flow/nodes/_base/_base.types";

/**
 * Runs the `Llm` node's generations on desktop (ADR-0021).
 *
 * The Rust actor no longer performs LLM calls: it forwards each `llmGenerate`
 * cloud request as an `llm-request` event, and this hook performs it with the
 * very same {@link performLlmGenerate} the browser reactor uses, injecting every
 * emission back through the `llm_result` command. One transport, both hosts —
 * so streaming, provider quirks and error text cannot differ between them.
 *
 * The mirror of `use-audio-requests.ts`, and inert off-desktop for the same
 * reason: in the browser the `CloudPerformer` already does this in-process.
 */
export function useLlmRequests() {
  // In-flight generations keyed by issuing node id. Latest-wins: a re-trigger
  // aborts its predecessor, matching the browser `CloudPerformer` (and the
  // Tokio abort table this replaced).
  const abortsRef = useRef(new Map<string, AbortController>());

  useEffect(() => {
    if (!isDesktop()) return;
    const aborts = abortsRef.current;
    return () => {
      for (const controller of aborts.values()) controller.abort();
      aborts.clear();
    };
  }, []);

  useListen<CloudRequest>({
    type: "llm-request",
    handler: ({ payload }) => {
      if (payload.kind !== "llmGenerate") return;
      void runLlmRequest(payload, abortsRef.current);
    },
  });
}

// The `Llm` node's output handles, typed against the catalog's `Llm` emits
// (ADR-0007) exactly as the browser `CloudPerformer` types its own — a renamed
// handle fails to compile on both sides at once.
const LLM_THINKING: EmitOf<"Llm"> = "thinking";
const LLM_VALUE: EmitOf<"Llm"> = "value";
const LLM_DONE: EmitOf<"Llm"> = "done";
const LLM_ERROR: EmitOf<"Llm"> = "error";

async function runLlmRequest(
  request: Extract<CloudRequest, { kind: "llmGenerate" }>,
  aborts: Map<string, AbortController>,
): Promise<void> {
  const { source } = request;
  const inject = (handle: string, value: boolean | string) => {
    void invoke("llm_result", { source, handle, value }).catch((error: unknown) => {
      console.error("[use-llm-requests] result inject failed:", error);
    });
  };

  const provider = useLlmProviderStore.getState().getProvider(request.providerId);
  if (!provider) {
    inject(LLM_THINKING, false);
    inject(LLM_ERROR, `LLM provider '${request.providerId}' not configured`);
    return;
  }

  aborts.get(source)?.abort();
  const controller = new AbortController();
  aborts.set(source, controller);

  try {
    // Loaded on first use — see the note in `cloud-performer.ts`.
    const { performLlmGenerate } = await import("@/lib/firmata/cloud/llm-client");
    const text = await performLlmGenerate(
      provider,
      { model: request.model, system: request.system, prompt: request.prompt },
      controller.signal,
      (textSoFar) => {
        if (!controller.signal.aborted) inject(LLM_VALUE, textSoFar);
      },
    );
    if (controller.signal.aborted) return;
    inject(LLM_THINKING, false);
    inject(LLM_VALUE, text);
    inject(LLM_DONE, true);
  } catch (error) {
    // A superseded generation drops silently — its result would route nowhere.
    if (controller.signal.aborted) return;
    inject(LLM_THINKING, false);
    inject(LLM_ERROR, error instanceof Error ? error.message : String(error));
  } finally {
    if (aborts.get(source) === controller) aborts.delete(source);
  }
}
