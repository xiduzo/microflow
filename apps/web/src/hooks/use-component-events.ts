import { useListen, type ComponentEventPayload } from "@/utils/ipc";
import { useSignalStore } from "@/stores/signal";
import { useNodeDataStore } from "@/stores/node-data";
import { useReactFlowStore } from "@/stores/react-flow";

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
      handleComponentEvent(payload, addSignal, updateNodeData);
    },
  });
}

function handleComponentEvent(
  event: ComponentEventPayload,
  addSignal: (edgeId: string) => void,
  updateNodeData: (id: string, data: unknown) => void
) {
  const { source, sourceHandle, value } = event;

  console.log("[COMPONENT-EVENT]", source, sourceHandle, value);

  // Get current edges from the store
  const edges = useReactFlowStore.getState().edges;

  // Find all edges that originate from this source node and handle
  const matchingEdges = edges.filter(
    (edge) => edge.source === source && edge.sourceHandle === sourceHandle
  );

  // Trigger signal animation on each matching edge
  for (const edge of matchingEdges) {
    addSignal(edge.id);

    // Update the target node's data with the event value
    updateNodeData(edge.target, value);
  }
}
