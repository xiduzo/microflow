import { useListen, type ComponentEventPayload } from "@/lib/ipc";
import { useSignalStore } from "@/stores/signal";
import { useNodeDataStore } from "@/stores/node-data";
import { useFlowSession } from "@/session";

/**
 * Listens to component events from the Tauri backend and updates the signal
 * store (for edge animations) and node data store.
 *
 * Mounted inside a `FlowSessionProvider`, so the session's `doc` is always
 * available for edge lookup.
 */
export function useComponentEvents() {
  const addSignal = useSignalStore((state) => state.addSignal);
  const updateNodeData = useNodeDataStore((state) => state.update);
  const { doc } = useFlowSession();

  useListen<ComponentEventPayload>({
    type: "component-event",
    handler: ({ payload }) => {
      const { source, sourceHandle, value } = payload;

      if (sourceHandle === "value" || sourceHandle === "event") updateNodeData(source, value);
      if (sourceHandle === "thinking") updateNodeData(`${source}:thinking`, value);

      console.log("[COMPONENT-EVENT]", { source, sourceHandle, value });

      const matchingEdges = doc
        .getEdges()
        .filter((edge) => edge.source === source && edge.sourceHandle === sourceHandle);

      for (const edge of matchingEdges) {
        addSignal(edge.id);
      }
    },
  });
}
