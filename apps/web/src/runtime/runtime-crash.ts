// How a desktop runtime crash reaches the user and the error reporter.
//
// The Rust actor catches a panicking turn, respawns the runtime and emits
// `runtime-crashed` (see `src-tauri/src/runtime/supervisor.rs`). The payload is
// non-PII by construction — an op name, a crate-relative code location and a
// hash of the two — and the hash is what the remote sinks group by.

import type { RuntimeCrash } from "@/lib/bindings/RuntimeCrash";
import { reportError } from "@/lib/report-error";

/** The crash as an error object, so local sinks log something readable. */
export class RuntimeCrashError extends Error {
  override name = "RuntimeCrash";
  constructor(readonly crash: RuntimeCrash) {
    super(`The flow runtime panicked in ${crash.op} at ${crash.location}`);
  }
}

/** The UI a crash needs: a toast that can stay up, and a page reload. */
export type CrashUi = {
  error: (
    title: string,
    options: {
      id: string;
      description: string;
      duration?: number;
      action?: { label: string; onClick: () => void };
    },
  ) => void;
  reload: () => void;
};

/** One toast id, so repeated crashes replace rather than stack. */
const TOAST_ID = "desktop-runtime-crash";

/**
 * Report the crash and tell the user. A recovered crash is a passing notice;
 * a halt (the crash-loop guard tripped) is a persistent error whose action
 * restarts the runtime and reloads the page, which re-sends the flow.
 */
export function surfaceRuntimeCrash(crash: RuntimeCrash, restart: () => Promise<void>, ui: CrashUi): void {
  reportError(new RuntimeCrashError(crash), { source: "desktop-runtime", fingerprint: crash.fingerprint });

  if (crash.recovered) {
    ui.error("The flow runtime crashed and was restarted", {
      id: TOAST_ID,
      description: "Your flow is running again. If this keeps happening, a node in it is failing.",
    });
    return;
  }

  ui.error("The flow runtime keeps crashing, so it was stopped", {
    id: TOAST_ID,
    description: `It crashed ${crash.crashes} times within a minute. The board is not being driven until you reload.`,
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: "Reload",
      onClick: () => {
        restart()
          .catch((error: unknown) => console.error("[runtime-crash] restart failed:", error))
          .finally(() => ui.reload());
      },
    },
  });
}
