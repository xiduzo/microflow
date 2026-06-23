// Reconcile-logic conformance for the browser MQTT host (ADR-0009 Phase 3),
// mirroring the desktop `flow_update` dedup/diff (commands.rs).

import { describe, expect, test } from "bun:test";
import {
  beats,
  diffSubscriptions,
  reconcileDesired,
  subKey,
  uidBrokers,
  type ActiveSub,
  type SubKind,
  type SubscriberWiring,
} from "../cloud/mqtt-subscriptions";

const wiring = (nodeId: string, kind: SubKind, brokerId: string, topic: string): SubscriberWiring => ({
  nodeId,
  kind,
  brokerId,
  topic,
});
const active = (nodeId: string, kind: SubKind, brokerId: string, topic: string): ActiveSub => ({
  nodeId,
  kind,
  brokerId,
  topic,
});

describe("reconcileDesired", () => {
  test("a routing kind wins over displayEcho on the same (broker, topic)", () => {
    const desired = reconcileDesired([
      wiring("zEcho", "displayEcho", "b", "t"),
      wiring("aRoute", "topicAware", "b", "t"),
    ]);
    expect(desired.size).toBe(1);
    expect(desired.get(subKey("b", "t"))?.nodeId).toBe("aRoute");
    expect(desired.get(subKey("b", "t"))?.kind).toBe("topicAware");
  });

  test("ties break on the lower node id", () => {
    const desired = reconcileDesired([wiring("n2", "plain", "b", "t"), wiring("n1", "plain", "b", "t")]);
    expect(desired.get(subKey("b", "t"))?.nodeId).toBe("n1");
  });

  test("distinct topics are each kept", () => {
    const desired = reconcileDesired([wiring("n1", "plain", "b", "t1"), wiring("n1", "plain", "b", "t2")]);
    expect(desired.size).toBe(2);
  });
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

test("beats: routing beats echo, else lower id wins", () => {
  const route = active("z", "plain", "b", "t");
  const echo = active("a", "displayEcho", "b", "t");
  expect(beats(route, echo)).toBe(true);
  expect(beats(echo, route)).toBe(false);
});
