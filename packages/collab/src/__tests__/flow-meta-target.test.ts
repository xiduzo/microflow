import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { FlowDocument } from "../schema";

// Task #29: the selected board target is persisted as Flow metadata so it
// travels with the Flow through the existing sync/persistence path and is
// restored when the Author re-opens the Flow in a later session.
describe("FlowMeta selectedTargetId", () => {
  test("is undefined on a Flow that has never had a target selected", () => {
    const doc = FlowDocument.createEmpty();
    expect(doc.getMeta().selectedTargetId).toBeUndefined();
  });

  test("setMeta records the selected target and getMeta reads it back", () => {
    const doc = FlowDocument.createEmpty();
    doc.setMeta({ selectedTargetId: "esp32" });
    expect(doc.getMeta().selectedTargetId).toBe("esp32");
  });

  // Scenario: Selected board target persists across sessions. Encoding the doc
  // and reloading it in a fresh document mirrors save → re-open.
  test("persists across an encode/decode round-trip (re-open in a later session)", () => {
    const doc = FlowDocument.createEmpty();
    doc.setMeta({ selectedTargetId: "nano" });
    const update = Y.encodeStateAsUpdate(doc.doc);

    const reopened = new FlowDocument(new Y.Doc());
    Y.applyUpdate(reopened.doc, update);

    expect(reopened.getMeta().selectedTargetId).toBe("nano");
  });

  test("onMetaChange fires when the selected target changes (BoardTargetSelected)", () => {
    const doc = FlowDocument.createEmpty();
    let fired = 0;
    const off = doc.onMetaChange(() => {
      fired += 1;
    });
    doc.setMeta({ selectedTargetId: "uno" });
    off();
    expect(fired).toBeGreaterThan(0);
  });
});
