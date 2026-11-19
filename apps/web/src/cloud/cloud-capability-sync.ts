import type { HostSnapshot } from "@/runtime/flow-update-dispatcher";

/**
 * One cloud capability (MQTT brokers, LLM providers, Figma) as the session
 * layer sees it. The production entries live in `cloud-capabilities.ts`; this
 * module stays store/IPC-free so the driver is testable in isolation (same
 * discipline as the injected `NodeAdapterRegistry` on the dispatcher).
 *
 * - `sync` — the config→runtime driver: `read()` a reference-stable config
 *   slice from the owning zustand store, `subscribe` to that store, and
 *   `push()` the current config to the runtime host's Service Registry.
 * - `listen` — optional runtime→store feedback channel (e.g. broker
 *   connection status events). Resolves to its cleanup once the channel is
 *   open: the capability's first push waits for that, so nothing the runtime
 *   says in answer to it is missed.
 * - `snapshot` — this capability's contribution to the dispatcher's
 *   `HostSnapshot`.
 * - `watchSnapshot` — optional: call `onChange` when that contribution changes,
 *   so the running flow is re-sent with it. Returns a cleanup.
 *
 * Adding a capability = one store + one entry here + one `HostSnapshot` field.
 */
export type CloudCapability = {
  name: string;
  sync?: {
    read(): unknown;
    subscribe(onChange: () => void): () => void;
    push(): void;
  };
  listen?: () => Promise<() => void>;
  snapshot(): Partial<HostSnapshot>;
  watchSnapshot?: (onChange: () => void) => () => void;
};

/**
 * Start the sync driver for every capability: push once on start, then
 * re-push whenever the capability's config slice changes. A capability that
 * listens has its channel opened first, and pushes once it is open, in
 * order. Returns a cleanup that unsubscribes everything; a push still
 * waiting for the channel then does not happen.
 */
export function startCloudCapabilitySync(
  capabilities: readonly CloudCapability[],
): () => void {
  const cleanups: Array<() => void> = [];
  for (const { sync, listen } of capabilities) {
    const listening = listen?.();
    if (listening) {
      cleanups.push(() => {
        listening.then(
          (stop) => stop(),
          () => {},
        );
      });
    }
    if (sync) {
      let stopped = false;
      cleanups.push(() => {
        stopped = true;
      });
      // A channel that failed to open is logged, and the pushes go ahead.
      const open = listening?.then(
        () => undefined,
        (error: unknown) => console.error(error),
      );
      const push = () => {
        if (!open) return void sync.push();
        void open.then(() => {
          if (!stopped) sync.push();
        });
      };
      let last = sync.read();
      push();
      cleanups.push(
        sync.subscribe(() => {
          const next = sync.read();
          // Config slices are reference-stable in the stores; unrelated state
          // churn (e.g. a status update) keeps the same reference → no re-push.
          if (Object.is(next, last)) return;
          last = next;
          push();
        }),
      );
    }
  }
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

/** Assemble the dispatcher's `HostSnapshot` from the capability registry —
 * the same registry that drives the sync, so the two can't drift. */
export function assembleHostSnapshot(
  capabilities: readonly CloudCapability[],
): HostSnapshot {
  return Object.assign(
    {},
    ...capabilities.map((cap) => cap.snapshot()),
  ) as HostSnapshot;
}

/** Call `onChange` whenever any capability's `HostSnapshot` contribution
 * changes. Returns a cleanup. */
export function watchHostSnapshot(
  capabilities: readonly CloudCapability[],
  onChange: () => void,
): () => void {
  const cleanups = capabilities.flatMap((cap) => (cap.watchSnapshot ? [cap.watchSnapshot(onChange)] : []));
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
