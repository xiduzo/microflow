import { LevaPanel, useControls, useCreateStore } from "leva";
import { useReactFlow, useUpdateNodeInternals } from "@xyflow/react";
import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useFlowStore } from "@/stores/flow-store";
import { useNode } from "./_base";

type UseControlParameters = Parameters<typeof useControls>;
export type Controls = Exclude<UseControlParameters[0], string | Function>;

/**
 * Bridges a node's Leva control panel to the Yjs-backed flow document.
 *
 * Three concerns live here:
 * 1. **Leva → Yjs commit** (the `controlsData` → `updateNodeData` effect):
 *    Deferred via `requestAnimationFrame` so that any synchronous
 *    `setNodeData()` calls from `onChange` callbacks land in Yjs first;
 *    otherwise `getNode(id)` reads stale data and the merge silently
 *    drops fields that the onChange just set.
 * 2. **History reverse-sync** (the `data` → `set` effect): when the user
 *    undoes/redoes a change, the Yjs `data` shifts but Leva's local store
 *    doesn't know; the effect compares and replays the change into Leva.
 * 3. **Settings panel portal** (`render`): renders the Leva panel into the
 *    sidebar `#settings-panels` slot only when this node is selected.
 *
 * `setNodeData` is an escape hatch for forced updates; it bypasses Leva
 * and may cause a one-frame divergence between `useNodeData` and the
 * actual node data.
 */
export const useNodeControls = <
  Data extends Record<string, any> = Record<string, any>,
  S extends Controls = Controls,
>(
  controls: S,
  dependencies: unknown[] = [],
) => {
  const store = useCreateStore();
  const { selected, id, data } = useNode();
  const isFirstRender = useRef(true);
  const { getNode } = useReactFlow();
  const onNodesChange = useFlowStore((state) => state.onNodesChange);
  const updateNodeInternals = useUpdateNodeInternals();

  const [controlsData, set] = useControls(
    () => ({ label: data.label, ...controls }),
    { store },
    dependencies,
  );
  const lastControlData = useRef(controlsData);

  const updateNodeData = useCallback(
    async (data: Record<string, unknown>) => {
      const node = getNode(id);
      if (!node) return;

      onNodesChange([
        {
          id: node.id,
          type: "replace",
          item: {
            ...node,
            data: { ...node.data, ...(data as Record<string, unknown>) },
          },
        },
      ]);
      updateNodeInternals(node.id);
      // Note: Flow sync is now automatic through FlowDocument observers
    },
    [id, getNode, onNodesChange, updateNodeInternals],
  );

  // Defer the Leva → node sync so that any setNodeData() calls made from
  // onChange callbacks (which fire synchronously before this effect) have
  // time to commit through the Yjs → ReactFlow cycle first.  Without the
  // deferral, getNode(id) inside updateNodeData reads stale data and the
  // merge silently drops fields that were just set by onChange/setNodeData.
  useEffect(() => {
    requestAnimationFrame(() => {
      updateNodeData(controlsData as Data);
    });
  }, [controlsData]);

  /**
   * Sometimes it is impossible to set the node data using the controls,
   * use this handler to forcefully update the node
   * ⚠️ this might cause descrepencies between the `data` from `useNodeData` and the actual data
   */
  const setNodeData = useCallback(
    <T extends Record<string, unknown>>(node: Partial<Data>) => {
      updateNodeData(node as T);
    },
    [updateNodeData],
  );

  const render = useCallback(() => {
    if (!selected) return null;
    const element = document.getElementById("settings-panels");
    if (!element) return;
    return createPortal(
      <LevaPanel store={store} hideCopyButton fill titleBar={false} />,
      element,
    );
  }, [store, selected]);

  /**
   * Sync the data back to the controls when history is reverted
   */
  useEffect(() => {
    if (isFirstRender.current) return;

    // Only compare keys which are in the controls data
    const keys = Object.keys(lastControlData.current as Record<string, unknown>);
    const dataKeys = Object.keys(data);

    // Check if any value has changed
    const hasChanged = keys.some(
      (key) =>
        dataKeys.includes(key) &&
        lastControlData.current[key as keyof typeof lastControlData.current] !==
          data[key as keyof typeof data],
    );
    if (!hasChanged) return;

    if (JSON.stringify(lastControlData.current) === JSON.stringify(data)) return;

    // Only get the keys which are in the controls data
    const newData = Object.fromEntries(
      Object.entries(data).filter(([key]) => keys.includes(key)),
    );
    // Prevent other effects from running
    lastControlData.current = newData as typeof lastControlData.current;
    set(newData as Parameters<typeof set>[0]);
    console.debug("[NODE-CONTROLS] <useEffect>", lastControlData.current, {
      data,
      newData,
    });
    // flowChanged();
  }, [data, set]);

  return { render, set, setNodeData };
};
