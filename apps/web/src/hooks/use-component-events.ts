import { useEffect, useRef } from "react";

import type { ComponentEvent } from "@/lib/bindings/ComponentEvent";
import { useListen } from "@/lib/ipc";
import { useFlowSession } from "@/session";
import { applyComponentEvent } from "@/lib/event-ingest";

/**
 * Listens to component events from the Tauri backend and applies them through
 * the same `applyComponentEvent` ingest the browser wasm reactor uses — node
 * values, edge-signal animations, and the devtools dev-log all in one place.
 *
 * The backend emits `component-event` for a single event and `component-events`
 * for a batch; both take the same path per event.
 *
 * Mounted inside a `FlowSessionProvider`, so the session's `doc` is always
 * available for edge lookup.
 */
export function useComponentEvents() {
  const { doc } = useFlowSession();

  // Edges are read when the flow changes, never per event: ingest keys its
  // `(source, handle) -> edge ids` index on this array's identity, so a fresh
  // `getEdges()` per event would rebuild the index every time.
  const edgesRef = useRef(doc.getEdges());
  useEffect(() => {
    edgesRef.current = doc.getEdges();
    return doc.onEdgesChange(() => {
      edgesRef.current = doc.getEdges();
    });
  }, [doc]);

  useListen<ComponentEvent>({
    type: "component-event",
    handler: ({ payload }) => {
      applyComponentEvent(payload, edgesRef.current);
    },
  });

  useListen<ComponentEvent[]>({
    type: "component-events",
    handler: ({ payload }) => {
      for (const event of payload) {
        applyComponentEvent(event, edgesRef.current);
      }
    },
  });
}
