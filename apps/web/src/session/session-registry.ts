import {
  createCloudSession,
  createLocalSession,
  type CreateCloudSessionOptions,
  type FlowSession,
} from "./flow-session";

const GRACE_PERIOD_MS = 100;

/**
 * How long a session built during render may wait for its first `acquire`.
 * Longer than `GRACE_PERIOD_MS`: render-to-commit can take a while on a heavy
 * tree, and losing the race only costs a rebuild, not correctness.
 */
const UNCLAIMED_GRACE_MS = 5_000;

type Entry = {
  session: FlowSession;
  refs: number;
  pendingDestroy: ReturnType<typeof setTimeout> | null;
};

const sessions = new Map<string, Entry>();

/**
 * The registered session for `flowId`, building it if absent — without taking
 * a reference. Safe to call during render: a render React throws away (Strict
 * Mode, an interrupted transition, Suspense) holds no reference, so its
 * session is reclaimed after `UNCLAIMED_GRACE_MS` instead of leaking a socket.
 * The reference is taken by `acquireSession`, from an effect.
 */
export function peekSession(
  flowId: string,
  build: () => FlowSession,
  unclaimedGraceMs = UNCLAIMED_GRACE_MS,
): FlowSession {
  const existing = sessions.get(flowId);
  if (existing) return existing.session;
  const entry: Entry = { session: build(), refs: 0, pendingDestroy: null };
  sessions.set(flowId, entry);
  scheduleDestroy(flowId, entry, unclaimedGraceMs);
  return entry.session;
}

export function acquireSession(flowId: string, build: () => FlowSession): FlowSession {
  const existing = sessions.get(flowId);
  if (existing) {
    if (existing.pendingDestroy) {
      clearTimeout(existing.pendingDestroy);
      existing.pendingDestroy = null;
    }
    existing.refs += 1;
    return existing.session;
  }
  const entry: Entry = { session: build(), refs: 1, pendingDestroy: null };
  sessions.set(flowId, entry);
  return entry.session;
}

export function acquireLocalSession(): FlowSession {
  return acquireSession("local", createLocalSession);
}

export function acquireCloudSession(options: CreateCloudSessionOptions): FlowSession {
  return acquireSession(options.flowId, () => createCloudSession(options));
}

export function releaseSession(flowId: string): void {
  const entry = sessions.get(flowId);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  if (entry.pendingDestroy) return;
  scheduleDestroy(flowId, entry, GRACE_PERIOD_MS);
}

function scheduleDestroy(flowId: string, entry: Entry, delayMs: number): void {
  entry.pendingDestroy = setTimeout(() => {
    entry.pendingDestroy = null;
    const current = sessions.get(flowId);
    if (current !== entry || entry.refs > 0) return;
    sessions.delete(flowId);
    entry.session.destroy();
  }, delayMs);
}

/**
 * Immediately destroys any registered session for `flowId` and removes it
 * from the registry, bypassing the grace period. Use when an external
 * action (e.g. template install) has invalidated the doc and the next
 * acquire must build a fresh one.
 */
export function evictSession(flowId: string): void {
  const entry = sessions.get(flowId);
  if (!entry) return;
  if (entry.pendingDestroy) clearTimeout(entry.pendingDestroy);
  sessions.delete(flowId);
  entry.session.destroy();
}

// ----- Test helpers (not exported via barrel) -----

export function __resetRegistry(): void {
  for (const [, entry] of sessions) {
    if (entry.pendingDestroy) clearTimeout(entry.pendingDestroy);
    entry.session.destroy();
  }
  sessions.clear();
}

export function __peekRegistry(flowId: string): Entry | undefined {
  return sessions.get(flowId);
}
