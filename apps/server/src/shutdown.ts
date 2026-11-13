/** What the shutdown hook drains: `YjsServer.shutdown` in production. */
export type Drain = (timeoutMs: number) => Promise<{ unsaved: string[] }>;

/** The slice of `process` the hook uses, so tests can drive it. */
export type SignalTarget = {
  on(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
};

export type ShutdownOptions = {
  /**
   * How long the drain may take. Must sit inside the orchestrator's stop grace
   * period (Docker's default is 10 s), or the process is SIGKILLed mid-write.
   */
  timeoutMs: number;
  exit: (code: number) => void;
};

/**
 * On SIGTERM/SIGINT, drain live collaboration rooms to the store, then exit.
 *
 * Without this a deploy kills the process with up to the persist ceiling of
 * accepted edits still only in memory. Exits non-zero when a room could not
 * be saved in time, so the loss is visible in the orchestrator's logs. A
 * second signal while draining is ignored rather than cutting the drain short.
 */
export function installShutdownHook(
  drain: Drain,
  target: SignalTarget,
  options: ShutdownOptions,
): void {
  let draining = false;

  const onSignal = (signal: string) => async () => {
    if (draining) return;
    draining = true;
    console.log(`[server] ${signal}: saving live rooms before exit`);
    let code = 0;
    try {
      const { unsaved } = await drain(options.timeoutMs);
      code = unsaved.length > 0 ? 1 : 0;
    } catch (error) {
      console.error("[server] shutdown drain failed", error);
      code = 1;
    }
    options.exit(code);
  };

  target.on("SIGTERM", onSignal("SIGTERM"));
  target.on("SIGINT", onSignal("SIGINT"));
}
