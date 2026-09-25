// Subscription diffing for the browser MQTT host (ADR-0009 Phase 3).
//
// The collapse + deterministic winner-selection ("which node owns a topic when
// several resolve to the same one") is shared policy that BOTH hosts must apply
// identically — it now lives ONCE in core (`reconcile_desired`) and reaches the
// browser through the wasm `reconcileSubscriptions()` binding, which returns an
// already-reconciled desired set. What stays here is host-local: diffing that
// desired set against THIS host's live subscriptions, and deriving the Figma uid
// lifecycle keys. No mqtt.js, no runtime: unit-testable.

import type { DesiredSub as ActiveSub } from "@/lib/bindings/DesiredSub";

/** The wiring kinds core reports (`SubKind` serialized by the wasm shim). */
export type { SubKind } from "@/lib/bindings/SubKind";

/**
 * A reconciled subscription — exactly one per (brokerId, topic). Core's
 * `DesiredSub`, as returned by `FlowRuntime.reconcileSubscriptions()`.
 */
export type { ActiveSub };

const KEY_SEP = " ";

/** Stable map key for a (broker, topic) pair. */
export function subKey(brokerId: string, topic: string): string {
  return `${brokerId}${KEY_SEP}${topic}`;
}

/**
 * Diff desired against live: `subscribe` is new or owner/kind-changed topics,
 * `unsubscribe` is topics gone from desired. Identical entries are untouched
 * (so moving a node — which leaves its wiring identical — is zero broker churn).
 */
export function diffSubscriptions(
  desired: Map<string, ActiveSub>,
  live: Map<string, ActiveSub>,
): { subscribe: ActiveSub[]; unsubscribe: ActiveSub[] } {
  const subscribe: ActiveSub[] = [];
  const unsubscribe: ActiveSub[] = [];
  for (const [key, d] of desired) {
    const l = live.get(key);
    if (!l || l.nodeId !== d.nodeId || l.kind !== d.kind) subscribe.push(d);
  }
  for (const [key, l] of live) {
    if (!desired.has(key)) unsubscribe.push(l);
  }
  return { subscribe, unsubscribe };
}

/**
 * uid → brokerId over `microflow/{uid}/...` topics — the Figma lifecycle key set
 * (announce `connected` / request variables when a uid appears, `disconnected`
 * when it goes). First broker seen per uid wins (matches the desktop).
 */
export function uidBrokers(subs: Iterable<ActiveSub>): Map<string, string> {
  const out = new Map<string, string>();
  for (const sub of subs) {
    const uid = microflowUid(sub.topic);
    if (uid !== undefined && !out.has(uid)) out.set(uid, sub.brokerId);
  }
  return out;
}

function microflowUid(topic: string): string | undefined {
  const parts = topic.split("/");
  if (parts[0] !== "microflow") return undefined;
  return parts[1] !== undefined && parts[1].length > 0 ? parts[1] : undefined;
}
