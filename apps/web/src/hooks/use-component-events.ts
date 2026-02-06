import { useListen, type ComponentEventPayload } from "@/lib/ipc";
import { useSignalStore } from "@/stores/signal";
import { useNodeDataStore } from "@/stores/node-data";
import { useFlowStore } from "@/stores/flow-store";

/**
 * Hook that listens to component events from the Tauri backend
 * and updates the signal store (for edge animations) and node data store.
 *
 * Should be called once at the app root level.
 */
export function useComponentEvents() {
  const addSignal = useSignalStore((state) => state.addSignal);
  const updateNodeData = useNodeDataStore((state) => state.update);

  useListen<ComponentEventPayload>({
    type: "component-event",
    handler: ({ payload }) => {
      const { source, sourceHandle, value } = payload;

      // Update node data when a "value" event is received
      if (sourceHandle === "value") updateNodeData(source, value);

      console.log("[COMPONENT-EVENT]", { source, sourceHandle, value });

      // Update the target node's data with the event value

      // Get current edges from the FlowDocument
      const flowDoc = useFlowStore.getState().flowDoc;
      const edges = flowDoc?.getEdges() ?? [];

      // Find all edges that originate from this source node and handle
      const matchingEdges = edges.filter(
        (edge) => edge.source === source && edge.sourceHandle === sourceHandle,
      );

      // Trigger signal animation on each matching edge
      for (const edge of matchingEdges) {
        addSignal(edge.id);
      }
    },
  });
}
