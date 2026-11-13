import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { createCloudSession } from "./flow-session";

describe("createCloudSession", () => {
  test("a seed persisted before ADR-0019 is upgraded before anything reads it", () => {
    // A server snapshot in the pre-ADR-0019 shape: nodes as plain objects.
    const legacy = new Y.Doc();
    legacy.getMap<unknown>("nodes").set("old", {
      id: "old",
      type: "Led",
      position: { x: 1, y: 2 },
      data: { pin: 13 },
    });

    const session = createCloudSession({
      flowId: "f1",
      // Never reached: the test reads the seeded doc and destroys the session.
      wsUrl: "ws://127.0.0.1:9",
      user: { id: "u1", name: "Tester" },
      initialData: Y.encodeStateAsUpdate(legacy),
    });
    try {
      const node = session.doc.getNode("old");
      expect(node?.type).toBe("Led");
      expect(node?.position).toEqual({ x: 1, y: 2 });
      expect(node?.data).toEqual({ pin: 13 });
      expect(session.doc.nodes.get("old")).toBeInstanceOf(Y.Map);
      // The upgrade is part of the seed, not an undoable edit.
      expect(session.doc.undoManager.undoStack).toHaveLength(0);
    } finally {
      session.destroy();
    }
  });
});
