import type { BoardTarget } from "@/lib/bindings/BoardTarget";

/**
 * The default board-target identifier applied when a Flow has no stored
 * selection (or stores an id that is no longer supported). Mirrors the backend
 * default in `runtime::commands::default_board_target` so the editor shows the
 * same target the generator would fall back to.
 */
export const DEFAULT_TARGET_ID = "uno";

/**
 * Resolve which board-target identifier is selected for a Flow, given the
 * supported targets and the id stored on the Flow's metadata.
 *
 * - When the stored id matches a supported target, that id wins.
 * - When the Flow has no stored selection, or the stored id is no longer
 *   supported, fall back to the default target (`uno`) when present, otherwise
 *   the first supported target. This keeps the editor working even if a Flow
 *   references a target that has since been removed.
 * - Returns `undefined` only when no targets are supported at all.
 */
export function resolveSelectedTargetId(
  targets: BoardTarget[],
  storedId: string | undefined,
): string | undefined {
  if (targets.length === 0) return undefined;
  if (storedId !== undefined && targets.some((t) => t.id === storedId)) {
    return storedId;
  }
  const fallback = targets.find((t) => t.id === DEFAULT_TARGET_ID) ?? targets[0];
  return fallback.id;
}

/** Options projected for a labelled, keyboard-navigable selector. */
export type TargetOption = { id: string; name: string };

/** Project supported targets into labelled options for the picker control. */
export function toTargetOptions(targets: BoardTarget[]): TargetOption[] {
  return targets.map((t) => ({ id: t.id, name: t.name }));
}
