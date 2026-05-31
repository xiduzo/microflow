import { useCallback } from "react";
import { toast } from "sonner";
import { useBoardStore } from "@/stores/board";
import {
  connectBoard,
  flashStandardFirmata,
  isWebSerialSupported,
  type BoardConnection,
} from "@/lib/firmata/web-serial";

/** True for errors that mean "the user dismissed the browser port picker". */
function isPickerDismissed(message: string): boolean {
  return /no port selected|cancelled|dismiss/i.test(message);
}

// One active browser board connection at a time (the desktop app manages its
// own connection in Rust). Kept at module scope so connect/disconnect from any
// component act on the same port.
let activeConnection: BoardConnection | null = null;

/**
 * Browser-only board connection control. On the desktop the board is
 * auto-detected in Rust and surfaced via Tauri events; in the browser the user
 * must explicitly connect (Web Serial requires a user gesture), so this exposes
 * connect/disconnect that drive the same `useBoardStore`.
 */
export function useWebSerialBoard() {
  const setBoard = useBoardStore((state) => state.setBoard);

  const connect = useCallback(async () => {
    if (activeConnection) return;
    setBoard({ state: "connecting" });
    try {
      activeConnection = await connectBoard({
        onState: setBoard,
        // Pin changes will feed live values once the browser runtime exists;
        // for now the connection + board state is the deliverable.
        onPinChange: () => {},
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Dismissing the browser's port picker is not an error.
      if (/no port selected|cancelled|dismiss/i.test(message)) {
        setBoard({ state: "disconnected" });
      } else {
        setBoard({ state: "error", error: message });
      }
    }
  }, [setBoard]);

  const disconnect = useCallback(async () => {
    const connection = activeConnection;
    activeConnection = null;
    await connection?.disconnect();
    setBoard({ state: "disconnected" });
  }, [setBoard]);

  const flash = useCallback(async () => {
    // Free the port if we are currently connected for Firmata.
    if (activeConnection) {
      const connection = activeConnection;
      activeConnection = null;
      await connection.disconnect();
    }
    setBoard({ state: "flashing", port: "", board: "" });
    const toastId = toast.loading("Flashing StandardFirmata…");
    try {
      const board = await flashStandardFirmata({
        onProgress: (done, total) => {
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;
          toast.loading(`Flashing StandardFirmata… ${pct}%`, { id: toastId });
        },
      });
      toast.success(`Flashed StandardFirmata to ${board}. Click Connect board.`, { id: toastId });
      setBoard({ state: "disconnected" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isPickerDismissed(message)) {
        toast.dismiss(toastId);
        setBoard({ state: "disconnected" });
      } else {
        toast.error(`Flashing failed: ${message}`, { id: toastId });
        setBoard({ state: "error", error: message });
      }
    }
  }, [setBoard]);

  return { supported: isWebSerialSupported(), connect, disconnect, flash };
}
