import type { ComponentValue } from "@/lib/bindings/ComponentValue";
import { nodeDataStore } from "@/nodes/live/node-data";
import { signalStore } from "@/editor/signal";
import { useDevLogStore } from "@/devtools/dev-log";
import { formatComponentValue } from "@/runtime/format-value";
import { edgeIdsFor, edgeIndexOf, type EdgeLike } from "@/runtime/ingest/edge-index";

/** A component event from either runtime (browser wasm or desktop IPC). */
type IngestedEvent = {
  source: string;
  sourceHandle: string;
  value: ComponentValue;
  sequence?: number;
};

export type { EdgeLike };

/**
 * The single place a component event is applied to the UI. Both runtimes — the
 * browser wasm reactor (`flow-reactor.ts`) and the desktop IPC listener
 * (`use-component-events.ts`) — funnel through here, so node values, edge-signal
 * animations, and the devtools dev-log stay in lock-step across platforms.
 *
 * Costs the emitting node's fan-out, not the size of the flow: `edges` is
 * indexed once per flow change, the value write wakes one node, and the
 * dev-log message is formatted only if the panel shows it.
 */
export function applyComponentEvent(event: IngestedEvent, edges: ReadonlyArray<EdgeLike>): void {
  // Latest value per node (and the LLM `thinking` side-channel).
  if (event.sourceHandle === "value" || event.sourceHandle === "event") {
    nodeDataStore.update(event.source, event.value);
  } else if (event.sourceHandle === "thinking") {
    nodeDataStore.update(`${event.source}:thinking`, event.value);
  }

  // Animate every wire leaving this (source, handle).
  for (const edgeId of edgeIdsFor(edgeIndexOf(edges), event.source, event.sourceHandle)) {
    signalStore.addSignal(edgeId);
  }

  // Feed the unified dev-log as the devtools' `flow` source.
  useDevLogStore.getState().record({
    level: "debug",
    source: "flow",
    message: () => `${event.source} · ${event.sourceHandle} → ${formatComponentValue(event.value)}`,
  });
}
