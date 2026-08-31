// Host-local subscription diffing for the browser MQTT host (ADR-0009 Phase 3).
//
// The collapse + winner-selection policy (`reconcileDesired`/`beats`) moved to
// core (`microflow-core` `subscriptions.rs` tests) — both hosts share it via the
// wasm `reconcileSubscriptions()` binding. What remains here is the host-local
// diff against this host's live set + the Figma uid lifecycle keys.

import { describe, expect, test } from "bun:test";
import {
  diffSubscriptions,
  subKey,
  uidBrokers,
  type ActiveSub,
  type SubKind,
} from "../cloud/mqtt-subscriptions";

const active = (nodeId: string, kind: SubKind, brokerId: string, topic: string): ActiveSub => ({
  nodeId,
  kind,
  brokerId,
  topic,
});

describe("diffSubscriptions", () => {
  test("new subscribes, gone unsubscribes, identical untouched", () => {
    const live = new Map([
      [subKey("b", "keep"), active("n", "plain", "b", "keep")],
      [subKey("b", "gone"), active("n", "plain", "b", "gone")],
    ]);
    const desired = new Map([
      [subKey("b", "keep"), active("n", "plain", "b", "keep")],
      [subKey("b", "new"), active("n", "plain", "b", "new")],
    ]);
    const { subscribe, unsubscribe } = diffSubscriptions(desired, live);
    expect(subscribe.map((s) => s.topic)).toEqual(["new"]);
    expect(unsubscribe.map((s) => s.topic)).toEqual(["gone"]);
  });

  test("an owner change re-subscribes the topic", () => {
    const live = new Map([[subKey("b", "t"), active("old", "plain", "b", "t")]]);
    const desired = new Map([[subKey("b", "t"), active("new", "plain", "b", "t")]]);
    expect(diffSubscriptions(desired, live).subscribe.map((s) => s.nodeId)).toEqual(["new"]);
  });
});

describe("uidBrokers", () => {
  test("maps uid → broker over microflow topics, ignoring others", () => {
    const map = uidBrokers([
      active("n", "topicAware", "b1", "microflow/u1/figma/variable/1-2"),
      active("n", "displayEcho", "b1", "microflow/u1/figma/status"),
      active("m", "plain", "b2", "sensors/x"),
    ]);
    expect(map.get("u1")).toBe("b1");
    expect(map.size).toBe(1);
  });
});
