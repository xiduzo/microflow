import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

import { resolveStoredLlmProvider } from "@/ai/llm-performer";
import { useNodeDiagnosticsStore } from "@/nodes/live/node-diagnostics";
import { isDesktop } from "@/platform/platform";
import { AudioPerformer } from "@/runtime/audio/audio-performer";
import { dispatchPort } from "@/runtime/dispatch-port";
import { DesktopRuntimeHost, type HostDocument } from "@/runtime/desktop-runtime-host";
import { applyComponentEvent } from "@/runtime/event-ingest";
import { surfaceRuntimeCrash } from "@/runtime/runtime-crash";

let host: DesktopRuntimeHost | null = null;

/** The app's one desktop host, wired to Tauri, the stores and the toaster. */
function desktopRuntimeHost(): DesktopRuntimeHost {
  host ??= new DesktopRuntimeHost({
    listen: (event, handler) => listen(event, (e) => handler(e.payload as never)),
    invoke: (command, args) => invoke(command, args),
    ingest: applyComponentEvent,
    applyDiagnostic: (diagnostic) => useNodeDiagnosticsStore.getState().apply(diagnostic),
    clearDiagnostics: () => useNodeDiagnosticsStore.getState().clear(),
    resolveLlmProvider: resolveStoredLlmProvider,
    createAudio: (resolveSrc, onEnded) => new AudioPerformer(resolveSrc, onEnded),
    dispatchPort,
    onCrash: (crash, restart) =>
      surfaceRuntimeCrash(crash, restart, {
        error: (title, options) => toast.error(title, options),
        reload: () => window.location.reload(),
      }),
  });
  return host;
}

// A hot-reloaded module would start a second host beside the first.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    host?.stop();
    host = null;
  });
}

/**
 * Start the desktop Runtime Host for the lifetime of the app. Mounted once, at
 * the root: it must outlive every route, because the runtime it serves does.
 * Inert off-desktop (the browser host is the board controller's reactor).
 */
export function useDesktopRuntimeHost(): void {
  useEffect(() => {
    if (isDesktop()) desktopRuntimeHost().start();
  }, []);
}

/** Attach the open flow's document to the desktop host while mounted. */
export function useDesktopFlowDocument(doc: HostDocument): void {
  useEffect(() => {
    if (!isDesktop()) return;
    return desktopRuntimeHost().attach(doc);
  }, [doc]);
}
