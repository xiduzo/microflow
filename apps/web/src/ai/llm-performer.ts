// The one performer of the `Llm` node's `llmGenerate` cloud request, used by
// both Runtime Hosts (ADR-0021).
//
// The transport (`llm-client.ts`) was already shared; the performing around it
// — resolve the provider, latest-wins cancellation per node, stream deltas onto
// `value`, settle `thinking`/`done` or `error` — was written twice: once in the
// browser `CloudPerformer`, once in the desktop's `use-llm-requests.ts` hook.
// Now both hosts hold an `LlmPerformer` and differ only in how a result
// re-enters their runtime: the browser calls the wasm `injectEvent`, the desktop
// invokes `llm_result`. That re-entry is the injected {@link LlmResultInjector}.

import type { CloudRequest } from "@/lib/bindings/CloudRequest";
import type { EmitOf } from "@/nodes/component-types.generated";
import type { LlmGenerateInput, LlmProviderConn } from "@/ai/llm-client";
import { useLlmProviderStore } from "@/ai/llm-provider";

export type LlmGenerateRequest = Extract<CloudRequest, { kind: "llmGenerate" }>;

/** Re-enter one result value on the issuing node's handle — the host's
 *  `injectEvent` (browser) or `llm_result` (desktop). */
export type LlmResultInjector = (source: string, handle: EmitOf<"Llm">, value: boolean | string) => void;

/** Resolve a `providerId` to its connection, or `undefined` if not configured. */
export type LlmProviderResolver = (providerId: string) => LlmProviderConn | undefined;

/** The transport's shape (`performLlmGenerate`), injectable for tests. */
export type LlmGenerate = (
  provider: LlmProviderConn,
  input: LlmGenerateInput,
  signal: AbortSignal,
  onDelta: (textSoFar: string) => void,
) => Promise<string>;

// The `Llm` node's output handles, typed against the catalog's `Llm` emits
// (ADR-0007): `EmitOf<"Llm">` is derived from the same node-components.json the
// Catalog Parity Guard pins the Rust `Llm::emits()` to, so a renamed handle
// fails to compile here.
const LLM_THINKING: EmitOf<"Llm"> = "thinking";
const LLM_VALUE: EmitOf<"Llm"> = "value";
const LLM_DONE: EmitOf<"Llm"> = "done";
const LLM_ERROR: EmitOf<"Llm"> = "error";

/** The transport, imported on first use: it pulls in TanStack AI and the OpenAI
 *  client, which is a lot of bundle for every user who never places an Llm
 *  node. By the time a request arrives they have. */
const loadedGenerate: LlmGenerate = async (provider, input, signal, onDelta) => {
  const { performLlmGenerate } = await import("@/ai/llm-client");
  return performLlmGenerate(provider, input, signal, onDelta);
};

/** Providers as the user configured them, read live so a credential edit
 *  applies to the next request. */
export const resolveStoredLlmProvider: LlmProviderResolver = (id) => {
  const provider = useLlmProviderStore.getState().getProvider(id);
  return provider ? { kind: provider.kind, baseUrl: provider.baseUrl, apiKey: provider.apiKey } : undefined;
};

/**
 * Performs `llmGenerate` requests and re-enters their results. `thinking = true`
 * was already emitted synchronously by the node's dispatch; this resolves the
 * provider, streams the answer onto `value`, then injects `thinking = false` +
 * `value`/`done` — or `thinking = false` + `error`.
 *
 * Latest-wins per node: a re-trigger aborts its predecessor, whose result is
 * then dropped (it would route nowhere). `dispose` aborts everything in flight.
 */
export class LlmPerformer {
  /** In-flight generations keyed by issuing node id. */
  private readonly aborts = new Map<string, AbortController>();
  private disposed = false;

  constructor(
    private readonly resolveProvider: LlmProviderResolver,
    private readonly inject: LlmResultInjector,
    private readonly generate: LlmGenerate = loadedGenerate,
  ) {}

  async perform(request: LlmGenerateRequest): Promise<void> {
    if (this.disposed) return;
    const { source } = request;
    const provider = this.resolveProvider(request.providerId);
    if (!provider) {
      this.injectError(source, `LLM provider '${request.providerId}' not configured`);
      return;
    }

    this.aborts.get(source)?.abort();
    const controller = new AbortController();
    this.aborts.set(source, controller);
    const dropped = () => controller.signal.aborted || this.disposed;

    try {
      const text = await this.generate(
        provider,
        { model: request.model, system: request.system, prompt: request.prompt },
        controller.signal,
        // Each delta re-injects the whole answer so far on `value`, so a
        // downstream Monitor fills in as the model writes. `thinking` stays
        // true until the run finishes — a partial answer is still pending.
        (textSoFar) => {
          if (!dropped()) this.inject(source, LLM_VALUE, textSoFar);
        },
      );
      if (dropped()) return;
      this.inject(source, LLM_THINKING, false);
      this.inject(source, LLM_VALUE, text);
      this.inject(source, LLM_DONE, true);
    } catch (error) {
      // A superseded or torn-down generation drops silently.
      if (dropped()) return;
      this.injectError(source, error instanceof Error ? error.message : String(error));
    } finally {
      if (this.aborts.get(source) === controller) this.aborts.delete(source);
    }
  }

  /** Abort every generation in flight; later requests are ignored. */
  dispose(): void {
    this.disposed = true;
    for (const controller of this.aborts.values()) controller.abort();
    this.aborts.clear();
  }

  private injectError(source: string, message: string): void {
    this.inject(source, LLM_THINKING, false);
    this.inject(source, LLM_ERROR, message);
  }
}
