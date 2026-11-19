// Subscription diffing for the browser MQTT host (ADR-0009 Phase 3).
//
// The collapse + deterministic winner-selection ("which node owns a topic when
// several resolve to the same one") is shared policy that BOTH hosts must apply
// identically — it now lives ONCE in core (`reconcile_desired`) and reaches the
// browser through the wasm `reconcileSubscriptions()` binding, which returns an
// already-reconciled desired set. What stays here is host-local: diffing that
// desired set against THIS host's live subscriptions, and deriving the Figma uid
// lifecycle keys. No mqtt.js, no runtime: unit-testable.

import { bridgeUid } from "@microflow/design-bridge";
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
 * Diff desired against a current set: `subscribe` is new or owner/kind-changed
 * topics, `unsubscribe` is topics gone from desired. Identical entries are
 * untouched (so moving a node — which leaves its wiring identical — is zero
 * broker churn).
 *
 * The performer takes `unsubscribe` against what it last asked the brokers for,
 * and `subscribe` against what they hold — so a topic a broker does not hold
 * yet is in `subscribe` again at every reconcile.
 */
export function diffSubscriptions(
  desired: Map<string, ActiveSub>,
  current: Map<string, ActiveSub>,
): { subscribe: ActiveSub[]; unsubscribe: ActiveSub[] } {
  const subscribe: ActiveSub[] = [];
  const unsubscribe: ActiveSub[] = [];
  for (const [key, d] of desired) {
    const c = current.get(key);
    if (!c || c.nodeId !== d.nodeId || c.kind !== d.kind) subscribe.push(d);
  }
  for (const [key, c] of current) {
    if (!desired.has(key)) unsubscribe.push(c);
  }
  return { subscribe, unsubscribe };
}

/**
 * uid → brokerId over design-bridge topics — the Figma lifecycle key set
 * (announce `connected` / request variables when a uid appears, `disconnected`
 * when it goes). Other `microflow/…` topics (e.g. a generic Mqtt node's) do not
 * count. A uid that is on several brokers keeps its `current` broker while one
 * of its topics is there; otherwise the first broker seen wins.
 */
export function uidBrokers(
  subs: Iterable<ActiveSub>,
  current: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const out = new Map<string, string>();
  for (const sub of subs) {
    const uid = bridgeUid(sub.topic);
    if (uid === undefined) continue;
    if (!out.has(uid) || current.get(uid) === sub.brokerId) out.set(uid, sub.brokerId);
  }
  return out;
}
