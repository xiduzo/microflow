import type { HostSnapshot } from "./flow-update-dispatcher";

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
 *   connection status events). Returns a cleanup.
 * - `snapshot` — this capability's contribution to the dispatcher's
 *   `HostSnapshot`.
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
  listen?: () => () => void;
  snapshot(): Partial<HostSnapshot>;
};

/**
 * Start the sync driver for every capability: push once on start, then
 * re-push whenever the capability's config slice changes. Returns a cleanup
 * that unsubscribes everything.
 */
export function startCloudCapabilitySync(
  capabilities: readonly CloudCapability[],
): () => void {
  const cleanups: Array<() => void> = [];
  for (const { sync, listen } of capabilities) {
    if (sync) {
      let last = sync.read();
      sync.push();
      cleanups.push(
        sync.subscribe(() => {
          const next = sync.read();
          // Config slices are reference-stable in the stores; unrelated state
          // churn (e.g. a status update) keeps the same reference → no re-push.
          if (Object.is(next, last)) return;
          last = next;
          sync.push();
        }),
      );
    }
    if (listen) cleanups.push(listen());
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
