import { useMemo } from "react";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { isDesktop } from "@/platform/platform";
import { emit } from "@tauri-apps/api/event";
import { useFlowNodes, useFlowSession } from "@/session";
import type { Hotkey } from "@tanstack/react-hotkeys";
import { keyEvent } from "@/board/board-controller";
import { hotkeyAccelerators } from "./hotkey-accelerators";

/**
 * Registers a TanStack hotkey for every accelerator a node of the current flow
 * listens on. On keydown/keyup the accelerator reaches the runtime, which
 * decides which nodes hear it and runs the flow from there. No logic lives
 * here.
 *
 * The two hosts differ only in the door the key goes through: desktop fires a
 * Tauri event for the actor, the browser calls into the wasm runtime. Behind
 * either door it is the same `dispatch_key_event`.
 *
 * Mounted inside a `FlowSessionProvider`.
 */
export function useHotkeyEvents() {
  const { doc } = useFlowSession();
  const nodes = useFlowNodes(doc);

  const accelerators = useMemo(() => hotkeyAccelerators(nodes), [nodes]);

  const hotkeys = useMemo(() => {
    const emitKeyEvent = (key: string, pressed: boolean) => {
      if (isDesktop()) {
        emit("key_event", { key, pressed });
        return;
      }
      keyEvent(key, pressed);
    };

    return accelerators.flatMap((key) => [
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
