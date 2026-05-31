import { useEffect } from "react";
import { connect, disconnect, start, supported } from "@/lib/firmata/board-controller";

/**
 * Browser-only board control. The desktop auto-detects the board in Rust; in the
 * browser the orchestration lives in `board-controller`, which auto-reconnects
 * any already-granted board on load / plug-in and folds flashing into connect.
 * This hook just starts that controller and exposes the gesture actions.
 */
export function useWebSerialBoard() {
  useEffect(() => {
    start();
  }, []);

  return { supported: supported(), connect, disconnect };
}
