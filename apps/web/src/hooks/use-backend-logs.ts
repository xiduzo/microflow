import { useListen } from "@/lib/ipc";
import { useDevLogStore, type DevLogLevel } from "@/stores/dev-log";

// `tauri-plugin-log`'s `LogLevel` serializes to 1..5 (repr); map to our names.
const LEVELS: Record<number, DevLogLevel> = {
  1: "trace",
  2: "debug",
  3: "info",
  4: "warn",
  5: "error",
};

// tauri-plugin-log's default format: `[date][time][target][LEVEL] message`.
const FORMATTED = /^\[[\d-]+\]\[[\d:.]+\]\[([^\]]+)\]\[[A-Za-z]+\]\s?([\s\S]*)$/;
// Fallback: a bare `[TAG]` prefix convention (e.g. `[MQTT] …`).
const TAGGED = /^\[([A-Za-z0-9_-]+)\]\s*([\s\S]*)$/;

/** Turn a Rust log target (`app_lib::mqtt::commands`) into a short source tag (`mqtt`). */
function sourceFromTarget(target: string): string {
  return target.replace(/^app_lib::/, "").split("::")[0] || "log";
}

/**
 * Forwards the desktop backend's `log::` records (hardware, MQTT, LLM, …) into
 * the unified dev-log, so the Microflow devtools shows the whole app's activity —
 * not just flow events. Backed by `tauri-plugin-log`'s webview target (the
 * `log://log` event). No-op on web. Mount once, app-wide.
 */
export function useBackendLogs() {
  useListen<{ message: string; level: number }>({
    type: "log://log",
    handler: ({ payload }) => {
      const level = LEVELS[payload.level] ?? "info";
      const raw = payload.message;

      const formatted = raw.match(FORMATTED);
      if (formatted) {
        useDevLogStore
          .getState()
          .record({ level, source: sourceFromTarget(formatted[1]), message: formatted[2] });
        return;
      }
      const tagged = raw.match(TAGGED);
      if (tagged) {
        useDevLogStore
          .getState()
          .record({ level, source: tagged[1].toLowerCase(), message: tagged[2] });
        return;
      }
      useDevLogStore.getState().record({ level, source: "log", message: raw });
    },
  });
}
