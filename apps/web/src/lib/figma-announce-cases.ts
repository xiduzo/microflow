// The Figma Announce Policy as a table: what Studio publishes when the map of
// Bridge ID → broker goes from `prev` to `next`.
//
// Test data, imported by tests only. The policy is core's
// `figma_announce_actions`; the browser reaches it through the wasm binding,
// and the CloudPerformer tests run on a TypeScript twin of it. Both are checked
// against this one table (`runtime/figma-announce.wasm.test.ts` on the compiled
// module, `cloud/cloud-performer.test.ts` on the twin), so a twin that drifts
// from the real policy, in content or in order, fails a test.

import type { FigmaPublish } from "@/lib/bindings/FigmaPublish";

/** One transition and the publishes it must give, in order. */
export type FigmaAnnounceCase = {
  name: string;
  prev: Record<string, string>;
  next: Record<string, string>;
  publishes: FigmaPublish[];
};

const status = (brokerId: string, uid: string, payload: string): FigmaPublish => ({
  brokerId,
  topic: `microflow/${uid}/app/status`,
  payload,
  retain: true,
});
const connected = (brokerId: string, uid: string): FigmaPublish[] => [
  status(brokerId, uid, "connected"),
  { brokerId, topic: `microflow/${uid}/app/variables/request`, payload: "", retain: false },
];
const disconnected = (brokerId: string, uid: string): FigmaPublish[] => [
  status(brokerId, uid, "disconnected"),
];

/**
 * Every departure comes before every arrival, and each group is in uid order
 * (by code unit, which is byte order for a Bridge ID's characters), whatever
 * order the maps were built in.
 */
export const FIGMA_ANNOUNCE_CASES: readonly FigmaAnnounceCase[] = [
  {
    name: "nothing before, nothing after",
    prev: {},
    next: {},
    publishes: [],
  },
  {
    name: "a Bridge ID appears",
    prev: {},
    next: { alpha: "b1" },
    publishes: connected("b1", "alpha"),
  },
  {
    name: "a Bridge ID vanishes",
    prev: { alpha: "b1" },
    next: {},
    publishes: disconnected("b1", "alpha"),
  },
  {
    // What a new link of the broker asks once it holds the Bridge ID's topic.
    name: "a Bridge ID stays where it is",
    prev: { alpha: "b1" },
    next: { alpha: "b1" },
    publishes: [],
  },
  {
    name: "nothing changes",
    prev: { alpha: "b1", bravo: "b2" },
    next: { alpha: "b1", bravo: "b2" },
    publishes: [],
  },
  {
    name: "a Bridge ID moves to another broker",
    prev: { alpha: "b2" },
    next: { alpha: "b1" },
    publishes: [...disconnected("b2", "alpha"), ...connected("b1", "alpha")],
  },
  {
    name: "two Bridge IDs swap brokers",
    prev: { alpha: "b1", bravo: "b2" },
    next: { alpha: "b2", bravo: "b1" },
    publishes: [
      ...disconnected("b1", "alpha"),
      ...disconnected("b2", "bravo"),
      ...connected("b2", "alpha"),
      ...connected("b1", "bravo"),
    ],
  },
  {
    name: "a Bridge ID moves and another arrives on the broker it left",
    prev: { bravo: "b1" },
    next: { bravo: "b2", alpha: "b1" },
    publishes: [
      ...disconnected("b1", "bravo"),
      ...connected("b1", "alpha"),
      ...connected("b2", "bravo"),
    ],
  },
  {
    name: "one Bridge ID vanishes and another appears",
    prev: { bravo: "b1" },
    next: { alpha: "b1" },
    publishes: [...disconnected("b1", "bravo"), ...connected("b1", "alpha")],
  },
  {
    name: "one moves, one vanishes, one appears, one stays",
    prev: { alpha: "b2", bravo: "b1", delta: "b1" },
    next: { alpha: "b1", charlie: "b2", delta: "b1" },
    publishes: [
      ...disconnected("b2", "alpha"),
      ...disconnected("b1", "bravo"),
      ...connected("b1", "alpha"),
      ...connected("b2", "charlie"),
    ],
  },
  {
    name: "maps built out of uid order",
    prev: { zulu1: "b1", alpha: "b1" },
    next: { yankee: "b1", bravo: "b1" },
    publishes: [
      ...disconnected("b1", "alpha"),
      ...disconnected("b1", "zulu1"),
      ...connected("b1", "bravo"),
      ...connected("b1", "yankee"),
    ],
  },
  {
    // A JavaScript object lists integer-like keys first, in numeric order.
    name: "Bridge IDs that look like numbers",
    prev: { "20000": "b1", "100000": "b1", alpha: "b1" },
    next: { "20000": "b2", "100000": "b2", "9000000": "b1" },
    publishes: [
      ...disconnected("b1", "100000"),
      ...disconnected("b1", "20000"),
      ...disconnected("b1", "alpha"),
      ...connected("b2", "100000"),
      ...connected("b2", "20000"),
      ...connected("b1", "9000000"),
    ],
  },
  {
    name: "Bridge IDs in upper case, lower case, with a dash and an underscore",
    prev: {},
    next: { alpha: "b1", _temp: "b1", Zebra: "b1", "-dash": "b1", "12345": "b1" },
    publishes: [
      ...connected("b1", "-dash"),
      ...connected("b1", "12345"),
      ...connected("b1", "Zebra"),
      ...connected("b1", "_temp"),
      ...connected("b1", "alpha"),
    ],
  },
];
