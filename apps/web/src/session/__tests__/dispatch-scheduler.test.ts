import { describe, expect, test } from "bun:test";
import { FlowDocument, type FlowNode } from "@microflow/collab";
import {
  DebounceScheduler,
  FlowUpdateDispatcher,
  ManualDispatchScheduler,
  type HostSnapshot,
  type NodeAdapterRegistry,
} from "../flow-update-dispatcher";
import type { FlowUpdate, FlowUpdateSender, SendResult } from "../flow-update-sender";
import type { FlowSession } from "../flow-session";

const EMPTY_REGISTRY: NodeAdapterRegistry = {};

const mkNode = (id: string, overrides: Partial<FlowNode> = {}): FlowNode => ({
  id,
  type: "Led",
  position: { x: 0, y: 0 },
  data: {},
  ...overrides,
});

const emptySnapshot = (): HostSnapshot => ({
  brokers: [],
  providers: [],
  figma: { uniqueId: null },
});

function makeSession(doc: FlowDocument): FlowSession {
  return {
    flowId: "test",
    mode: "local",
    readOnly: false,
    doc,
    sync: { kind: "local", destroy: () => {} },
    destroy: () => {},
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("DebounceScheduler", () => {
  test("coalesces a burst into one run", async () => {
    const scheduler = new DebounceScheduler(20, 10_000);
    let runs = 0;

    for (let i = 0; i < 10; i++) scheduler.schedule(() => runs++);
    expect(runs).toBe(0);

    await wait(40);
    expect(runs).toBe(1);
  });

  test("runs the most recent callback, not the first", async () => {
    const scheduler = new DebounceScheduler(15, 10_000);
    const seen: number[] = [];

    scheduler.schedule(() => seen.push(1));
    scheduler.schedule(() => seen.push(2));
    scheduler.schedule(() => seen.push(3));

    await wait(35);
    expect(seen).toEqual([3]);
  });

  test("fires despite continuous requests once the ceiling is reached", async () => {
    // Wait longer than the test's lifetime: without a ceiling this never runs.
    const scheduler = new DebounceScheduler(10_000, 30);
    let runs = 0;

    const started = Date.now();
    while (Date.now() - started < 60) {
      scheduler.schedule(() => runs++);
      await wait(5);
    }

    // A pure debounce would still be at zero — the runtime would have gone the
    // whole session without an update while somebody kept typing.
    expect(runs).toBeGreaterThan(0);
    scheduler.cancel();
  });

  test("cancel actually cancels", async () => {
    const scheduler = new DebounceScheduler(15, 10_000);
    let runs = 0;

    scheduler.schedule(() => runs++);
    scheduler.cancel();

    await wait(35);
    expect(runs).toBe(0);
  });
});

describe("FlowUpdateDispatcher ordering", () => {
  /** A sender whose sends resolve when the test says so, out of order. */
  class GatedSender implements FlowUpdateSender {
    readonly sent: FlowUpdate[] = [];
    private readonly gates: Array<() => void> = [];

    send(update: FlowUpdate): Promise<SendResult> {
      this.sent.push(update);
      return new Promise<SendResult>((resolve) => {
        this.gates.push(() => resolve({ ok: true }));
      });
    }

    /** Resolve the nth send (0-based). */
    release(index: number): void {
      this.gates[index]?.();
    }
  }

  test("an out-of-order response does not install a stale dispatch key", async () => {
    const doc = FlowDocument.createEmpty();
    const sender = new GatedSender();
    const scheduler = new ManualDispatchScheduler();
    const dispatcher = new FlowUpdateDispatcher(
      makeSession(doc),
      emptySnapshot,
      sender,
      scheduler,
      EMPTY_REGISTRY,
    );

    // Send A: the empty flow.
    scheduler.flush();
    expect(sender.sent).toHaveLength(1);

    // Send B: one node. Overlaps A, and finishes first.
    doc.addNode(mkNode("n1"));
    scheduler.flush();
    expect(sender.sent).toHaveLength(2);

    sender.release(1); // B completes
    await Promise.resolve();
    sender.release(0); // A completes late, carrying the older key
    await Promise.resolve();
    await Promise.resolve();

    // The dispatcher's remembered key must describe B (one node), not A
    // (empty). If A's key won, going back to an empty flow would look like a
    // repeat and be skipped.
    doc.removeNode("n1");
    scheduler.flush();
    await Promise.resolve();

    expect(sender.sent).toHaveLength(3);
    expect(sender.sent[2]!.nodes).toHaveLength(0);

    dispatcher.destroy();
  });
});
