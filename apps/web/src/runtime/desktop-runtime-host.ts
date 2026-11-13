// The desktop Runtime Host's webview half, for the lifetime of the app.
//
// The flow runtime runs in the Rust actor (`src-tauri/src/runtime/host.rs`), an
// app-lifetime thread that keeps running the last flow whatever page is open.
// Its webview half — applying component events and node diagnostics, playing
// audio, performing LLM generations, surfacing a runtime crash — used to be a
// set of hooks mounted on the flow route, so navigating away unmounted them
// while the actor kept emitting: events went unapplied, and an in-flight LLM
// generation was aborted with its reply dropped.
//
// This module is that half as one object, started once at the root and never
// torn down by navigation. The flow route only *attaches* its document, which
// supplies what an event needs from the flow (edges for wire animation, a Music
// node's audio files); with no document attached the host keeps working on
// what it has.
//
// Every platform touch is an injected dependency, so the host unit-tests with
// a fake event bus and no Tauri, React or store (`desktop-runtime-host.test.ts`).
// The production wiring is `use-desktop-runtime-host.ts`.

import type { ComponentEvent } from "@/lib/bindings/ComponentEvent";
import type { CloudRequest } from "@/lib/bindings/CloudRequest";
import type { RuntimeCrash } from "@/lib/bindings/RuntimeCrash";
import type { NodeDiagnostic } from "@/runtime/effects-sink";
import type { EdgeLike } from "@/runtime/ingest/edge-index";
import type { AudioEnded, AudioSrcResolver } from "@/runtime/audio/audio-performer";
import { audioSourcesOf } from "@/runtime/audio/audio-performer";
import { LlmPerformer, type LlmGenerate, type LlmProviderResolver } from "@/ai/llm-performer";
import type { FlowSession } from "@/session";

/** What the host reads from the active flow document. */
export type HostDocument = Pick<
  FlowSession["doc"],
  "getEdges" | "onEdgesChange" | "getNode" | "getNodes" | "onNodesChange"
>;

/** The audio output the host drives (an `AudioPerformer`). */
export type HostAudio = {
  play(nodeId: string, track: number, volume: number, loop: boolean): void;
  stop(nodeId: string): void;
  retain(nodeIds: { has(nodeId: string): boolean }): void;
  dispose(): void;
};

export type DesktopRuntimeHostDeps = {
  /** Subscribe to a Tauri event; resolves to the unsubscribe. */
  listen: <T>(event: string, handler: (payload: T) => void) => Promise<() => void>;
  /** Invoke a Tauri command. */
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** Apply one component event to the UI (`applyComponentEvent`). */
  ingest: (event: ComponentEvent, edges: ReadonlyArray<EdgeLike>) => void;
  /** Apply a node diagnostic to the badge store. */
  applyDiagnostic: (diagnostic: NodeDiagnostic) => void;
  /** Drop every badge: the runtime that raised them is gone. */
  clearDiagnostics: () => void;
  resolveLlmProvider: LlmProviderResolver;
  /** The LLM transport; defaults to the real one. */
  generateLlm?: LlmGenerate;
  createAudio: (resolveSrc: AudioSrcResolver, onEnded: AudioEnded) => HostAudio;
  /** Dispatch a value on a node's port (a finished record's `stop`). */
  dispatchPort: (nodeId: string, port: string, value: boolean) => void;
  /** Tell the user and the error reporter; `restart` leaves a crash-loop halt. */
  onCrash: (crash: RuntimeCrash, restart: () => Promise<void>) => void;
};

export class DesktopRuntimeHost {
  private started = false;
  private unlistens: Array<Promise<() => void>> = [];
  private doc: HostDocument | null = null;
  private edges: ReadonlyArray<EdgeLike> = [];
  private llm: LlmPerformer | null = null;
  private audio: HostAudio | null = null;

  constructor(private readonly deps: DesktopRuntimeHostDeps) {}

  /** Start listening. Idempotent: the host is one per app. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const { deps } = this;

    this.llm = new LlmPerformer(
      deps.resolveLlmProvider,
      (source, handle, value) => {
        deps.invoke("llm_result", { source, handle, value }).catch((error: unknown) => {
          console.error("[desktop-runtime-host] llm_result failed:", error);
        });
      },
      deps.generateLlm,
    );
    this.audio = deps.createAudio(
      (nodeId, track) => {
        const data = this.doc?.getNode(nodeId)?.data;
        return data ? audioSourcesOf(data)[track] : undefined;
      },
      (nodeId) => deps.dispatchPort(nodeId, "stop", false),
    );

    this.on<ComponentEvent>("component-event", (event) => deps.ingest(event, this.edges));
    this.on<ComponentEvent[]>("component-events", (events) => {
      for (const event of events) deps.ingest(event, this.edges);
    });
    this.on<NodeDiagnostic>("node-diagnostic", deps.applyDiagnostic);
    this.on<CloudRequest>("audio-request", (request) => {
      if (request.kind === "audioPlay") {
        this.audio?.play(request.source, request.track, request.volume, request.loop);
      } else if (request.kind === "audioStop") {
        this.audio?.stop(request.source);
      }
    });
    this.on<CloudRequest>("llm-request", (request) => {
      if (request.kind === "llmGenerate") void this.llm?.perform(request);
    });
    this.on<RuntimeCrash>("runtime-crashed", (crash) => {
      // The badges belong to the runtime that panicked; a respawned one
      // re-reports what is still true as it re-applies the flow.
      deps.clearDiagnostics();
      deps.onCrash(crash, async () => {
        await deps.invoke("runtime_restart");
      });
    });
  }

  /** Stop listening and abort in-flight work. Only for app teardown (HMR). */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const unlisten of this.unlistens) {
      unlisten.then((fn) => fn()).catch((error: unknown) => console.error(error));
    }
    this.unlistens = [];
    this.llm?.dispose();
    this.audio?.dispose();
    this.llm = null;
    this.audio = null;
  }

  /**
   * Make `doc` the flow the host reads from — the flow route's session
   * document. Returns the detach, which leaves the host running: a later
   * document replaces this one, and until then events apply without wires.
   */
  attach(doc: HostDocument): () => void {
    this.doc = doc;
    // Edges are read when the flow changes, never per event: ingest keys its
    // `(source, handle) -> edge ids` index on the array's identity.
    this.edges = doc.getEdges();
    const retainLive = () => this.audio?.retain(new Set(doc.getNodes().map((node) => node.id)));
    // A Music node not in this flow must not keep playing — the runtime drops
    // the component silently, so the document is what tells us it is gone.
    retainLive();
    const offEdges = doc.onEdgesChange(() => {
      if (this.doc === doc) this.edges = doc.getEdges();
    });
    const offNodes = doc.onNodesChange(() => {
      if (this.doc === doc) retainLive();
    });
    return () => {
      offEdges();
      offNodes();
      if (this.doc !== doc) return;
      this.doc = null;
      this.edges = [];
    };
  }

  private on<T>(event: string, handler: (payload: T) => void): void {
    this.unlistens.push(this.deps.listen<T>(event, handler));
  }
}
