import { describe, expect, test } from "bun:test";
import { FlowDocument, flowStructureKey, projectFlowStructure } from "./schema";

const NODE = {
  id: "led-1",
  type: "Led",
  position: { x: 0, y: 0 },
  data: { pin: 13, label: "Led" },
};

function docWithNode() {
  const doc = FlowDocument.createEmpty();
  doc.addNode({ ...NODE, data: { ...NODE.data } });
  return doc;
}

describe("no-op write guard", () => {
  test("writing value-equal data twice fires the observer once", () => {
    const doc = docWithNode();
    let fires = 0;
    doc.onNodesChange(() => fires++);

    doc.updateNodeData("led-1", { pin: 9 });
    doc.updateNodeData("led-1", { pin: 9 });

    expect(fires).toBe(1);
    expect(doc.getNode("led-1")?.data.pin).toBe(9);
  });

  test("writing value-equal data twice records one undo entry", () => {
    const doc = docWithNode();
    doc.clearHistory();

    doc.updateNodeData("led-1", { pin: 9 });
    // Break the UndoManager's capture window so a second write could only be
    // absorbed by the no-op guard, never by rapid-change grouping.
    doc.undoManager.stopCapturing();
    doc.updateNodeData("led-1", { pin: 9 });
    doc.undoManager.stopCapturing();
    doc.updateNodeData("led-1", { pin: 9 });

    expect(doc.undoManager.undoStack.length).toBe(1);
    doc.undo();
    expect(doc.getNode("led-1")?.data.pin).toBe(13);
  });

  test("re-writing the data a node already holds writes nothing at all", () => {
    const doc = docWithNode();
    let fires = 0;
    doc.onNodesChange(() => fires++);

    doc.updateNodeData("led-1", { pin: 13, label: "Led" });

    expect(fires).toBe(0);
  });

  test("nested data is compared by value, not identity", () => {
    const doc = FlowDocument.createEmpty();
    doc.addNode({ ...NODE, data: { range: [0, 1023], tags: { unit: "ms" } } });
    let fires = 0;
    doc.onNodesChange(() => fires++);

    doc.updateNodeData("led-1", { range: [0, 1023], tags: { unit: "ms" } });
    expect(fires).toBe(0);

    doc.updateNodeData("led-1", { range: [0, 512], tags: { unit: "ms" } });
    expect(fires).toBe(1);
  });

  test("the guard covers updateNode, updateNodePosition and updateEdge too", () => {
    const doc = docWithNode();
    doc.addNode({ id: "b", type: "Led", position: { x: 5, y: 5 }, data: {} });
    doc.addEdge({ id: "e1", source: "led-1", target: "b", sourceHandle: "out" });

    let nodeFires = 0;
    let edgeFires = 0;
    doc.onNodesChange(() => nodeFires++);
    doc.onEdgesChange(() => edgeFires++);

    doc.updateNode("led-1", { type: "Led" });
    doc.updateNodePosition("led-1", { x: 0, y: 0 });
    doc.updateEdge("e1", { source: "led-1" });

    expect(nodeFires).toBe(0);
    expect(edgeFires).toBe(0);
  });
});

describe("structural projection", () => {
  test("moving a node does not change the structure", () => {
    const doc = docWithNode();
    const before = flowStructureKey(doc.getNodes(), doc.getEdges());

    doc.updateNodePosition("led-1", { x: 400, y: 250 });

    expect(doc.getNode("led-1")?.position).toEqual({ x: 400, y: 250 });
    expect(flowStructureKey(doc.getNodes(), doc.getEdges())).toBe(before);
  });

  test("selecting, dragging and resizing a node do not change the structure", () => {
    const doc = docWithNode();
    const before = flowStructureKey(doc.getNodes());

    doc.updateNode("led-1", { selected: true, dragging: true, width: 320, height: 90 });

    expect(flowStructureKey(doc.getNodes())).toBe(before);
  });

  test("changing a node's config does change the structure", () => {
    const doc = docWithNode();
    const before = flowStructureKey(doc.getNodes());

    doc.updateNodeData("led-1", { pin: 9 });

    expect(flowStructureKey(doc.getNodes())).not.toBe(before);
  });

  test("edge endpoints count, edge id and styling do not", () => {
    const withId = flowStructureKey(
      [NODE],
      [{ id: "e1", source: "a", target: "b", type: "smoothstep", selected: true }],
    );
    const withOtherId = flowStructureKey([NODE], [{ id: "e2", source: "a", target: "b" }]);
    const rewired = flowStructureKey([NODE], [{ id: "e1", source: "a", target: "c" }]);

    expect(withId).toBe(withOtherId);
    expect(rewired).not.toBe(withId);
  });

  test("doc ordering does not change the structure", () => {
    const other = { id: "led-2", type: "Led", position: { x: 9, y: 9 }, data: {} };
    expect(flowStructureKey([NODE, other])).toBe(flowStructureKey([other, NODE]));
  });

  test("visual fields are absent from the projection", () => {
    const projected = projectFlowStructure([{ ...NODE, selected: true, width: 10 }]).nodes[0]!;
    expect(Object.keys(projected)).toEqual(["id", "type", "data"]);
  });
});
