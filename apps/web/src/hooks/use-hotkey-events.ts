import { useMemo } from "react";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { isDesktop } from "@/lib/platform";
import { emit } from "@tauri-apps/api/event";
import { useFlowNodes, useFlowSession } from "@/session";
import type { Hotkey } from "@tanstack/react-hotkeys";
import { NODE_REGISTRY } from "@/components/flow/nodes/_REGISTRY";
import { isComponentType } from "@/components/flow/nodes/_base/_base.types";
import { dispatchToNode } from "@/lib/firmata/board-controller";

/**
 * Registers TanStack hotkeys for every Hotkey node in the current flow.
 * On keydown/keyup the key reaches the runtime, which handles all component
 * routing and flow graph processing. No logic lives here.
 *
 * The two hosts differ only in how the key gets there: desktop fires a Tauri
 * event and lets Rust find the registered Hotkey components; the browser has no
 * such registry on the host side, so it dispatches straight into the wasm
 * runtime's `key_event` port on the nodes that asked for this accelerator.
 *
 * Mounted inside a `FlowSessionProvider`.
 */
export function useHotkeyEvents() {
  const { doc } = useFlowSession();
  const nodes = useFlowNodes(doc);

  /** accelerator -> the node ids listening for it (one key may drive several). */
  const listeners = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const node of nodes) {
      const instance = node.data?.instance;
      if (typeof instance !== "string" || !isComponentType(instance)) continue;
      const accel = NODE_REGISTRY[instance].adapter?.accelerator?.(node);
      if (!accel) continue;
      const ids = out.get(accel);
      if (ids) ids.push(node.id);
      else out.set(accel, [node.id]);
    }
    return out;
  }, [nodes]);

  const hotkeys = useMemo(() => {
    const emitKeyEvent = (key: string, pressed: boolean) => {
      if (isDesktop()) {
        emit("key_event", { key, pressed });
        return;
      }
      for (const nodeId of listeners.get(key) ?? []) {
        dispatchToNode(nodeId, "key_event", pressed);
      }
    };

    return [...listeners.keys()].flatMap((key) => [
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
  }, [listeners]);

  useHotkeys(hotkeys);
}
