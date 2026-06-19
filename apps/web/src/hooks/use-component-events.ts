import { useListen, type ComponentEventPayload } from "@/lib/ipc";
import { useFlowSession } from "@/session";
import { applyComponentEvent } from "@/lib/event-ingest";

/**
 * Listens to component events from the Tauri backend and applies them through
 * the same `applyComponentEvent` ingest the browser wasm reactor uses — node
 * values, edge-signal animations, and the devtools dev-log all in one place.
 *
 * Mounted inside a `FlowSessionProvider`, so the session's `doc` is always
 * available for edge lookup.
 */
export function useComponentEvents() {
  const { doc } = useFlowSession();

  useListen<ComponentEventPayload>({
    type: "component-event",
    handler: ({ payload }) => {
      applyComponentEvent(payload, doc.getEdges());
    },
  });
}
