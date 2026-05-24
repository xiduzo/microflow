import {
  createCloudSession,
  createLocalSession,
  type CreateCloudSessionOptions,
  type FlowSession,
} from "./flow-session";

const GRACE_PERIOD_MS = 100;

type Entry = {
  session: FlowSession;
  refs: number;
  pendingDestroy: ReturnType<typeof setTimeout> | null;
};

const sessions = new Map<string, Entry>();

function acquire(flowId: string, build: () => FlowSession): FlowSession {
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
  return acquire("local", createLocalSession);
}

export function acquireCloudSession(options: CreateCloudSessionOptions): FlowSession {
  return acquire(options.flowId, () => createCloudSession(options));
}

export function releaseSession(flowId: string): void {
  const entry = sessions.get(flowId);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  if (entry.pendingDestroy) return;
  entry.pendingDestroy = setTimeout(() => {
    const current = sessions.get(flowId);
    if (current !== entry) return;
    sessions.delete(flowId);
    entry.session.destroy();
  }, GRACE_PERIOD_MS);
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
