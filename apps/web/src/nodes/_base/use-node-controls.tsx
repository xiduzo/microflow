import { LevaPanel, useControls, useCreateStore } from "leva";
import { useUpdateNodeInternals } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useFlowSession } from "@/session";
import { useNode } from "./_base";
import { createNodeDataCommitter } from "./node-data-commit";

type UseControlParameters = Parameters<typeof useControls>;
export type Controls = Exclude<UseControlParameters[0], string | Function>;

/**
 * Bridges a node's Leva control panel to the Yjs-backed flow document.
 *
 * This is only the Leva adapter: schema in, values out. The commit policy —
 * write ordering, echo suppression, the readOnly guard, per-field write scope
 * — lives in `createNodeDataCommitter` (`./node-data-commit`), where it is
 * testable without Leva or ReactFlow.
 *
 * Two effects wire the two directions:
 * 1. **Leva → Yjs**: every `controlsData` change is handed to the committer,
 *    which defers, coalesces and suppresses echoes before writing per-field
 *    through `FlowDocument.updateNodeData` (ADR-0019).
 * 2. **Yjs → Leva**: when the doc's `data` shifts under us (remote edit,
 *    undo/redo), the committer diffs it against the controls and hands back
 *    the patch to replay via `set` — recorded so the replay's own commit is
 *    dropped rather than written back in a loop.
 *
 * `render` portals the Leva panel into the sidebar `#settings-panels` slot
 * only while this node is selected.
 *
 * `setNodeData` is the escape hatch for values the controls cannot express
 * (transient `onChange` controls, dialog saves); it writes immediately, ahead
 * of any scheduled controls commit.
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
  const { doc, readOnly } = useFlowSession();
  const updateNodeInternals = useUpdateNodeInternals();

  const [controlsData, set] = useControls(
    () => ({ label: data.label, ...controls }),
    { store },
    dependencies,
  );

  const committer = useMemo(
    () => createNodeDataCommitter({ doc, nodeId: id, readOnly }),
    [doc, id, readOnly],
  );

  // Leva → Yjs. Leva's controlsData identity churns on every render, so this
  // runs far more often than the values change; the committer's echo
  // suppression is what keeps the render → doc-write → render cycle from
  // sustaining itself.
  useEffect(() => {
    committer.commit(controlsData as Record<string, unknown>);
  }, [committer, controlsData]);

  // Yjs → Leva, and a handle re-measure on any real data change (local echo
  // or remote). Reads the controls through a ref so a replay does not retrigger
  // this effect with its own result.
  const controlsRef = useRef(controlsData);
  controlsRef.current = controlsData;
  useEffect(() => {
    const patch = committer.reconcile(data, controlsRef.current as Record<string, unknown>);
    if (patch) set(patch as Parameters<typeof set>[0]);
    updateNodeInternals(id);
  }, [committer, data, id, set, updateNodeInternals]);

  /**
   * Sometimes it is impossible to set the node data using the controls,
   * use this handler to forcefully update the node — it bypasses Leva and
   * writes immediately, so it may cause a one-frame divergence between
   * `useNodeData` and the actual node data.
   */
  const setNodeData = useCallback(
    (node: Partial<Data>) => {
      committer.forceCommit(node as Record<string, unknown>);
      updateNodeInternals(id);
    },
    [committer, id, updateNodeInternals],
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

  return { render, set, setNodeData };
};
