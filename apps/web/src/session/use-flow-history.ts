import { useCallback, useEffect, useState } from "react";
import type { FlowDocument } from "@microflow/collab";

export function useFlowHistory(doc: FlowDocument) {
  const [canUndo, setCanUndo] = useState(() => doc.canUndo());
  const [canRedo, setCanRedo] = useState(() => doc.canRedo());

  useEffect(() => {
    const update = () => {
      setCanUndo(doc.canUndo());
      setCanRedo(doc.canRedo());
    };
    update();
    const manager = doc.undoManager;
    manager.on("stack-item-added", update);
    manager.on("stack-item-popped", update);
    return () => {
      manager.off("stack-item-added", update);
      manager.off("stack-item-popped", update);
    };
  }, [doc]);

  const undo = useCallback(() => doc.undo(), [doc]);
  const redo = useCallback(() => doc.redo(), [doc]);

  return { canUndo, canRedo, undo, redo };
}
