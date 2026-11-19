// The current-flow block is what stops a small model rebuilding nodes it
// already placed, so it has to actually name them. The catalogue is what the
// model wires from, so it has to name every handle a node can have, with the
// setting that gives the node that handle.

import { describe, expect, test } from "bun:test";
import { FlowDocument } from "@microflow/collab";

import { NODE_CATALOG } from "@/nodes/catalog.generated";
import { COMPONENT_TYPES, type ComponentType } from "@/nodes/component-types.generated";
import { handleVariants, liveHandles } from "@/nodes/handles";
import { askAiSystemPrompt, currentFlowPrompt } from "./catalog-prompt";

describe("the node catalogue in the system prompt", () => {
  const lines = askAiSystemPrompt(true).split("\n");

  /** The catalogue entry of `type`: its indented lines, or `null` when it has none. */
  function entry(type: ComponentType): string[] | null {
    const start = lines.findIndex((line) => line.startsWith(`- ${type}: `));
    if (start === -1) return null;
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => !line.startsWith("  "));
    return rest.slice(0, end === -1 ? undefined : end);
  }

  /** The handle names in a listing such as `a, b, plus one input per …`. */
  const names = (listing: string | undefined) => (listing ?? "").split(", ");

  const settingsText = (settings: Readonly<Record<string, unknown>>) =>
    Object.entries(settings)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(", ");

  test("every handle of every node is listed, with the setting that gives the node that handle", () => {
    for (const type of COMPONENT_TYPES) {
      const { defaults } = NODE_CATALOG[type];
      const block = entry(type);
      if (defaults.group === "internal") {
        expect({ type, listed: block !== null }).toEqual({ type, listed: false });
        continue;
      }
      if (block === null) throw new Error(`${type} has no catalogue entry`);

      const { bySettings, follows, openPorts } = handleVariants(type);
      // What the entry must say: each configuration, and how a line for it starts.
      const configurations =
        bySettings.length === 0
          ? [{ label: "its only handle set", ins: /^ {2}in: (.*)$/, outs: /^ {2}out: (.*)$/, handles: liveHandles(type, defaults) }]
          : bySettings.map(({ settings, handles }) => {
              // "with" is how the prompt says "set this"; a setting that follows
              // from something else is listed without it.
              const prefix = `  ${follows ? "" : "with "}${settingsText(settings)}: `.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&",
              );
              return {
                label: settingsText(settings),
                ins: new RegExp(`^${prefix}in (.*); out .*$`),
                outs: new RegExp(`^${prefix}in .*; out (.*)$`),
                handles,
              };
            });

      for (const { label, ins, outs, handles } of configurations) {
        const inLine = block.map((line) => ins.exec(line)?.[1]).find((found) => found !== undefined);
        const outLine = block.map((line) => outs.exec(line)?.[1]).find((found) => found !== undefined);
        for (const port of handles.ports) {
          expect({ type, label, port, listed: names(inLine).includes(port) }).toEqual({ type, label, port, listed: true });
        }
        for (const emit of handles.emits) {
          expect({ type, label, emit, listed: names(outLine).includes(emit) }).toEqual({ type, label, emit, listed: true });
        }
        // Open ports cannot be listed by name; what names them must be said.
        if (openPorts) expect({ type, label, inLine }).toEqual({ type, label, inLine: expect.stringContaining(openPorts) });
      }
    }
  });

  test("a node whose settings decide its handles shows no handle without its setting", () => {
    expect(entry("Mqtt")?.slice(0, 2)).toEqual([
      '  with direction="publish": in trigger; out (none)',
      '  with direction="subscribe": in (none); out value',
    ]);
    expect(entry("Servo")?.slice(0, 2)).toEqual([
      '  with type="standard": in min, value, max; out value',
      '  with type="continuous": in value, stop; out value',
    ]);
    expect(entry("Midi")).toContain('  with direction="in", mode="cc": in (none); out value');
  });

  test("a setting that follows from something else is not offered as one to set", () => {
    // A design variable's `resolvedType` is the type of the variable the user
    // picked. The model reads which ports go with which type; it does not write it.
    const figma = entry("Figma") ?? [];
    expect(figma.slice(0, 2)).toEqual([
      "  handles follow the type of the design variable the user picks in the node's settings (shown as resolvedType; do not set it):",
      '  resolvedType="BOOLEAN": in true, toggle, false; out change',
    ]);
    expect(figma).toContain('  resolvedType="COLOR": in red, green, blue, opacity; out change');
    expect(figma.some((line) => line.startsWith("  with "))).toBe(false);
  });

  test("a node with open ports says what names them", () => {
    expect(entry("Function")).toContain("  in: trigger, plus one input per {{name}} in `code`");
    expect(entry("Llm")).toContain("  in: trigger, plus one input per {{name}} in `prompt`");
    expect(entry("Music")).toContain(
      "  in: play, stop, set, plus one input per record, named after `tracks[].name`",
    );
  });

  test("a node whose handles never change keeps the plain two lines", () => {
    expect(entry("Led")?.slice(0, 2)).toEqual(["  in: true, toggle, value, false", "  out: value"]);
    expect(entry("Constant")?.slice(0, 2)).toEqual(["  in: (none)", "  out: value"]);
  });
});

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
