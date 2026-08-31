import { describe, expect, test } from "bun:test";
import { FlowDocument } from "@microflow/collab";
import type { AwarenessUser } from "./sync-adapter";
import { RecordingSyncAdapter } from "./recording-sync-adapter";
import {
  collaboratorsSlice,
  cursorsSlice,
  observePresence,
  remoteDragSlice,
  type DragMap,
} from "./presence";

function makeAdapter() {
  const doc = FlowDocument.createEmpty();
  return new RecordingSyncAdapter({ doc, user: { id: "local", name: "Local" } });
}

const peer = (overrides: Partial<AwarenessUser> = {}): AwarenessUser => ({
  id: "peer-1",
  name: "Peer",
  color: "#123456",
  icon: "Cat",
  clientId: 999,
  ...overrides,
});

describe("remoteDragSlice", () => {
  test("a peer's drag lands in the slice and the drop clears it", () => {
    const adapter = makeAdapter();
    const seen: (DragMap | null)[] = [];
    observePresence(adapter, remoteDragSlice, (value) => seen.push(value));
    expect(seen).toEqual([null]);

    adapter.injectAwareness([peer({ draggingNodes: { n1: { x: 5, y: 6 } } })]);
    expect(seen.at(-1)).toEqual({ n1: { x: 5, y: 6 } });

    adapter.injectAwareness([peer()]);
    expect(seen.at(-1)).toBeNull();
    expect(seen.length).toBe(3);
  });

  test("an identical drag frame does not renotify", () => {
    const adapter = makeAdapter();
    let notifications = 0;
    observePresence(adapter, remoteDragSlice, () => notifications++);

    adapter.injectAwareness([peer({ draggingNodes: { n1: { x: 5, y: 6 } } })]);
    adapter.injectAwareness([peer({ draggingNodes: { n1: { x: 5, y: 6 } } })]);
    expect(notifications).toBe(2); // initial null + first frame only
  });

  test("the local user's own drag is not a remote drag", () => {
    const adapter = makeAdapter();
    let latest: DragMap | null = null;
    let notifications = 0;
    observePresence(adapter, remoteDragSlice, (value) => {
      latest = value;
      notifications++;
    });

    adapter.injectAwareness([
      { ...adapter.localUser!, draggingNodes: { n1: { x: 1, y: 1 } } },
    ]);
    expect(latest).toBeNull();
    expect(notifications).toBe(1); // the initial value only
  });
});

describe("cursorsSlice", () => {
  test("a selection- or drag-only change does not fire the cursor slice", () => {
    const adapter = makeAdapter();
    let notifications = 0;
    observePresence(adapter, cursorsSlice, () => notifications++);

    adapter.injectAwareness([peer({ cursor: { x: 1, y: 2 } })]);
    const afterCursor = notifications;

    adapter.injectAwareness([peer({ cursor: { x: 1, y: 2 }, selectedNodes: ["a"] })]);
    adapter.injectAwareness([
      peer({ cursor: { x: 1, y: 2 }, draggingNodes: { n1: { x: 0, y: 0 } } }),
    ]);
    expect(notifications).toBe(afterCursor);

    adapter.injectAwareness([peer({ cursor: { x: 3, y: 2 } })]);
    expect(notifications).toBe(afterCursor + 1);
  });

  test("a peer without a cursor is not in the slice", () => {
    const adapter = makeAdapter();
    let latest: AwarenessUser[] = [];
    observePresence(adapter, cursorsSlice, (value) => (latest = value));

    adapter.injectAwareness([peer(), peer({ id: "peer-2", clientId: 998, cursor: { x: 7, y: 8 } })]);
    expect(latest.map((u) => u.id)).toEqual(["peer-2"]);
  });
});

describe("collaboratorsSlice", () => {
  test("blind to pointer traffic, awake for identity changes", () => {
    const adapter = makeAdapter();
    let notifications = 0;
    observePresence(adapter, collaboratorsSlice, () => notifications++);

    adapter.injectAwareness([peer({ cursor: { x: 1, y: 1 } })]);
    const afterJoin = notifications;

    adapter.injectAwareness([peer({ cursor: { x: 2, y: 2 } })]);
    adapter.injectAwareness([peer({ cursor: { x: 3, y: 3 } })]);
    expect(notifications).toBe(afterJoin);

    adapter.injectAwareness([peer({ cursor: { x: 3, y: 3 }, name: "Renamed" })]);
    expect(notifications).toBe(afterJoin + 1);
  });
});

describe("observePresence", () => {
  test("unsubscribe stops notifications", () => {
    const adapter = makeAdapter();
    let notifications = 0;
    const unsubscribe = observePresence(adapter, remoteDragSlice, () => notifications++);

    unsubscribe();
    adapter.injectAwareness([peer({ draggingNodes: { n1: { x: 1, y: 1 } } })]);
    expect(notifications).toBe(1); // the initial value only
  });
});
