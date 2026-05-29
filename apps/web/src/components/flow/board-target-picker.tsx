import { useEffect, useMemo, useState } from "react";
import type { BoardTarget } from "@/lib/bindings/BoardTarget";
import { listBoardTargets } from "@/lib/ipc";
import { useFlowSession, useFlowMeta } from "@/session";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { resolveSelectedTargetId, toTargetOptions } from "./board-target-picker.model";

/**
 * Load the supported board targets once. Returns an empty list until the
 * backend responds (and off-desktop), so the picker renders nothing selectable
 * rather than crashing.
 */
function useBoardTargets(): BoardTarget[] {
  const [targets, setTargets] = useState<BoardTarget[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listBoardTargets().then((t) => {
      if (!cancelled) setTargets(t);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return targets;
}

/**
 * Board-target picker for the editor. Lists the supported targets, shows the
 * Flow's selected target (defaulting when none is stored or the stored id is no
 * longer supported), and on change writes the chosen id to the Flow's metadata.
 *
 * Persisting via `doc.setMeta` records the selection on the Flow document so it
 * travels through the existing sync/persistence path and is restored on
 * re-open. The same write raises the Flow's meta-change notification — the
 * `BoardTargetSelected` signal — which the sketch view reacts to by
 * re-generating against the new board.
 */
export function BoardTargetPicker() {
  const { doc, readOnly } = useFlowSession();
  const meta = useFlowMeta(doc);
  const targets = useBoardTargets();

  const options = useMemo(() => toTargetOptions(targets), [targets]);
  const selectedId = resolveSelectedTargetId(targets, meta.selectedTargetId);

  // Once targets are known, persist the resolved default so the Flow carries an
  // explicit selection going forward (and dependent behavior sees a concrete id).
  useEffect(() => {
    if (readOnly) return;
    if (selectedId === undefined) return;
    if (meta.selectedTargetId === selectedId) return;
    doc.setMeta({ selectedTargetId: selectedId });
  }, [doc, readOnly, selectedId, meta.selectedTargetId]);

  if (options.length === 0) return null;

  const handleChange = (id: string | null) => {
    if (readOnly || id === null) return;
    doc.setMeta({ selectedTargetId: id });
  };

  return (
    <Select value={selectedId} onValueChange={handleChange} disabled={readOnly}>
      <SelectTrigger aria-label="Board target" className="h-9 w-44">
        <SelectValue placeholder="Select board" />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
