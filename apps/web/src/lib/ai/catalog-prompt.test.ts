// The current-flow block is what stops a small model rebuilding nodes it
// already placed, so it has to actually name them.

import { describe, expect, test } from "bun:test";
import { FlowDocument } from "@microflow/collab";

process.env.VITE_SERVER_URL ??= "http://localhost:3000";
const { currentFlowPrompt } = await import("./catalog-prompt");

describe("currentFlowPrompt", () => {
  test("says so when the canvas is empty", () => {
    expect(currentFlowPrompt(new FlowDocument())).toContain("empty");
  });

  test("lists nodes with their config and edges with their handles", () => {
    const doc = new FlowDocument();
    doc.addNode({ id: "btn", type: "Button", position: { x: 0, y: 0 }, data: { pin: 3 } });
    doc.addNode({ id: "led", type: "Led", position: { x: 0, y: 0 }, data: { pin: 13 } });
    doc.addEdge({
      id: "e1",
      source: "btn",
      sourceHandle: "active",
      target: "led",
      targetHandle: "toggle",
    });

    const prompt = currentFlowPrompt(doc);
    expect(prompt).toContain("- btn: Button (pin=3)");
    expect(prompt).toContain("- led: Led (pin=13)");
    expect(prompt).toContain("- e1: btn.active → led.toggle");
  });
});

describe("currentFlowPrompt — selection", () => {
  test("narrows to the selected nodes and the edges between them", () => {
    const doc = new FlowDocument();
    doc.addNode({ id: "btn", type: "Button", position: { x: 0, y: 0 }, data: { pin: 3 } });
    doc.addNode({ id: "led", type: "Led", position: { x: 0, y: 0 }, data: { pin: 13 } });
    doc.addNode({ id: "mon", type: "Monitor", position: { x: 0, y: 0 }, data: {} });
    doc.addEdge({
      id: "e1",
      source: "btn",
      sourceHandle: "active",
      target: "led",
      targetHandle: "toggle",
    });
    doc.addEdge({
      id: "e2",
      source: "btn",
      sourceHandle: "active",
      target: "mon",
      targetHandle: "show",
    });

    const prompt = currentFlowPrompt(doc, ["btn", "led"]);
    expect(prompt).toContain("selected these 2 of 3 nodes");
    expect(prompt).toContain("- btn: Button");
    expect(prompt).not.toContain("- mon:");
    expect(prompt).toContain("- e1:");
    expect(prompt).not.toContain("- e2:");
  });

  test("ignores ids that are no longer on the canvas", () => {
    const doc = new FlowDocument();
    doc.addNode({ id: "led", type: "Led", position: { x: 0, y: 0 }, data: { pin: 13 } });
    expect(currentFlowPrompt(doc, ["gone"])).toContain("already on the canvas");
  });
});
