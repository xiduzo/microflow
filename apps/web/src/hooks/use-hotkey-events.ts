import { useMemo } from "react";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { isDesktop } from "@/lib/platform";
import { emit } from "@tauri-apps/api/event";
import { useFlowStore } from "@/stores/flow-store";
import { useFlowNodes } from "@/hooks/use-flow-document";
import type { Hotkey } from "@tanstack/react-hotkeys";
import { NODE_REGISTRY } from "@/components/flow/nodes/_REGISTRY";
import { isComponentType } from "@/components/flow/nodes/_base/_base.types";

/**
 * Registers TanStack hotkeys for every Hotkey node in the current flow.
 * On keydown/keyup, fires a Tauri event so the Rust runtime handles all
 * component routing and flow graph processing. No logic lives here.
 *
 * Uses `requireReset` to suppress OS key-repeat — only the initial
 * keydown fires, then nothing until keyup.
 *
 * Mount once at the app root level.
 */
export function useHotkeyEvents() {
  const flowDoc = useFlowStore((s) => s.flowDoc);
  const nodes = useFlowNodes(flowDoc);

  // Walk each node's host adapter to collect accelerator keys.
  // The adapter is owned by the node's component module — see _base/host-adapter.ts.
  const accelerators = useMemo(() => {
    const out: string[] = [];
    for (const node of nodes) {
      const instance = node.data?.instance;
      if (typeof instance !== "string" || !isComponentType(instance)) continue;
      const accel = NODE_REGISTRY[instance].adapter?.accelerator?.(node);
      if (accel) out.push(accel);
    }
    return out;
  }, [nodes]);

  const hotkeys = useMemo(() => {
    // Collect unique accelerator keys from Hotkey nodes
    const keys = new Set<string>(accelerators);

    const emitKeyEvent = (key: string, pressed: boolean) => {
      if (isDesktop()) {
        emit("key_event", { key, pressed });
      }
    };

    // Register both keydown and keyup for each key
    return [...keys].flatMap((key) => [
      {
        hotkey: key as Hotkey,
        callback: () => emitKeyEvent(key, true),
        options: {
          eventType: "keydown" as const,
          requireReset: true,
          ignoreInputs: true,
          preventDefault: false,
          stopPropagation: false,
        },
      },
      {
        hotkey: key as Hotkey,
        callback: () => emitKeyEvent(key, false),
        options: {
          eventType: "keyup" as const,
          ignoreInputs: true,
          preventDefault: false,
          stopPropagation: false,
        },
      },
    ]);
  }, [accelerators]);

  useHotkeys(hotkeys);
}
