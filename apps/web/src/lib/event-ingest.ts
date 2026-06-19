import type { ComponentValue } from "@/lib/bindings/ComponentValue";
import { useNodeDataStore } from "@/stores/node-data";
import { useSignalStore } from "@/stores/signal";
import { useDevLogStore } from "@/stores/dev-log";
import { formatComponentValue } from "@/lib/format-value";

/** A component event from either runtime (browser wasm or desktop IPC). */
type IngestedEvent = {
  source: string;
  sourceHandle: string;
  value: ComponentValue;
  sequence?: number;
};

/** The edge fields ingest needs; both `CoreEdge` and collab `FlowEdge` satisfy it. */
type EdgeLike = {
  id?: string | null;
  source: string;
  sourceHandle?: string | null;
};

/**
 * The single place a component event is applied to the UI. Both runtimes — the
 * browser wasm reactor (`flow-reactor.ts`) and the desktop IPC listener
 * (`use-component-events.ts`) — funnel through here, so node values, edge-signal
 * animations, and the devtools dev-log stay in lock-step across platforms.
 */
export function applyComponentEvent(event: IngestedEvent, edges: ReadonlyArray<EdgeLike>): void {
  // Latest value per node (and the LLM `thinking` side-channel).
  if (event.sourceHandle === "value" || event.sourceHandle === "event") {
    useNodeDataStore.getState().update(event.source, event.value);
  } else if (event.sourceHandle === "thinking") {
    useNodeDataStore.getState().update(`${event.source}:thinking`, event.value);
  }

  // Animate every wire leaving this (source, handle).
  const addSignal = useSignalStore.getState().addSignal;
  for (const edge of edges) {
    if (edge.id && edge.source === event.source && edge.sourceHandle === event.sourceHandle) {
      addSignal(edge.id);
    }
  }

  // Feed the unified dev-log as the devtools' `flow` source.
  useDevLogStore.getState().record({
    level: "debug",
    source: "flow",
    message: `${event.source} · ${event.sourceHandle} → ${formatComponentValue(event.value)}`,
  });
}
