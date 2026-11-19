import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import { FlowDocument, type FlowEdge, type FlowNode } from "@microflow/collab";

import { NODE_CATALOG } from "@/nodes/catalog.generated";
import type { ComponentType } from "@/nodes/component-types.generated";
import { resolveNodeData } from "@/nodes/node-data-resolver";
import {
  decodeFlowFile,
  encodeFlowFile,
  FLOW_FILE_VERSION,
  MAX_FLOW_FILE_SIZE,
  refuseFlowFileOfSize,
  type DecodedFlowFile,
} from "./flow-file";
import { TEMPLATES } from "./templates";

/** A node as the app places it: the type's defaults plus `overrides`. */
function node(id: string, type: ComponentType, overrides: Record<string, unknown> = {}): FlowNode {
  const resolved = resolveNodeData(type, overrides);
  if (!resolved.ok) throw new Error(resolved.error);
  return { id, type, position: { x: 0, y: 0 }, data: resolved.data };
}

function edge(id: string, source: string, sourceHandle: string, target: string, targetHandle: string): FlowEdge {
  return { id, source, sourceHandle, target, targetHandle };
}

/** The text of a file holding these nodes and edges, with any JSON-able value in their place. */
function fileOf(nodes: unknown, edges: unknown, rest: Record<string, unknown> = {}): string {
  return JSON.stringify({ meta: { name: "Test" }, data: { nodes, edges }, version: 1, ...rest });
}

function decoded(text: string): Extract<DecodedFlowFile, { ok: true }> {
  const result = decodeFlowFile(text);
  if (!result.ok) throw new Error(`expected the file to decode: ${result.problem}`);
  return result;
}

function problem(text: string): string {
  const result = decodeFlowFile(text);
  if (result.ok) throw new Error("expected the file to be refused");
  return result.problem;
}

/** The notices of a file, as kind and subject. */
const notices = (text: string) => decoded(text).notices.map(({ kind, id }) => (id === undefined ? { kind } : { kind, id }));

/** What the flow document gives back for these nodes and edges once they have landed in it. */
function asLanded(nodes: FlowNode[], edges: FlowEdge[] = []) {
  const doc = FlowDocument.createEmpty();
  doc.setFlowData(nodes, edges);
  const landed = JSON.parse(JSON.stringify(doc.getFlowData()));
  doc.destroy();
  return landed as { nodes: FlowNode[]; edges: FlowEdge[] };
}

describe("a flow, exported and decoded", () => {
  for (const template of TEMPLATES) {
    test(`the ${template.name} template comes back unchanged`, () => {
      // The way the editor exports: the flow is in a document, and the file is
      // written from what the document gives.
      const doc = FlowDocument.createEmpty();
      doc.setMeta({ name: template.name });
      doc.setFlowData(template.nodes, template.edges);
      const exported = doc.getFlowData();
      const text = encodeFlowFile(doc.getMeta(), exported);
      doc.destroy();

      const result = decoded(text);
      expect(result.notices).toEqual([]);
      expect(result.flow.name).toBe(template.name);
      expect(result.flow.nodes).toEqual(exported.nodes);
      expect(result.flow.nodes).toEqual(template.nodes);
      expect(result.flow.edges).toStrictEqual(exported.edges);
      expect(result.flow.edges).toStrictEqual(template.edges);
    });
  }

  // Every component type decodes from its own defaults without a remark: the
  // codec and the catalog agree on what a freshly placed node looks like.
  for (const type of Object.keys(NODE_CATALOG) as ComponentType[]) {
    test(`a freshly placed ${type} comes back unchanged`, () => {
      const placed = node("n", type);
      const result = decoded(fileOf([placed], []));
      expect(result.notices).toEqual([]);
      expect(result.flow.nodes).toEqual(JSON.parse(JSON.stringify([placed])));
    });
  }

  test("a node's size and an edge's type come back", () => {
    const nodes = [{ ...node("a", "Interval"), width: 320, height: 180 }, node("b", "Led")];
    const edges = [{ ...edge("e", "a", "event", "b", "toggle"), type: "animated" }];
    const result = decoded(encodeFlowFile({ name: "Sized" }, { nodes, edges }));
    expect(result.flow.nodes).toEqual(nodes);
    expect(result.flow.edges).toStrictEqual(edges);
  });

  test("an empty flow is a flow", () => {
    const result = decoded(encodeFlowFile({ name: "Empty" }, { nodes: [], edges: [] }));
    expect(result).toEqual({ ok: true, flow: { name: "Empty", nodes: [], edges: [] }, notices: [] });
  });
});

describe("encodeFlowFile", () => {
  test("writes the format released versions of the app read", () => {
    const nodes = [node("a", "Interval")];
    const at = new Date("2026-11-18T10:00:00.000Z");
    expect(JSON.parse(encodeFlowFile({ name: "Blink", description: "On and off", updatedAt: 42 }, { nodes, edges: [] }, at))).toEqual({
      meta: { name: "Blink", description: "On and off", version: 1, updatedAt: 42 },
      data: { nodes: JSON.parse(JSON.stringify(nodes)), edges: [] },
      version: 1,
      exportedAt: "2026-11-18T10:00:00.000Z",
    });
  });

  test("the file's version is the format's, not the flow's", () => {
    const text = encodeFlowFile({ name: "Blink", version: 7 }, { nodes: [], edges: [] });
    expect(JSON.parse(text).version).toBe(FLOW_FILE_VERSION);
    expect(JSON.parse(text).meta.version).toBe(7);
  });
});

describe("decodeFlowFile: a file the app exported before this codec", () => {
  // `fixtures/export-at-22ac4da.json` is a version 1 file as the app wrote it
  // at commit 22ac4da, the last one before this codec. It was produced on
  // 2026-11-19 by a script that did what the app does: a `FlowDocument` with
  // the meta of a new local flow; twelve nodes added as the picker adds them
  // (`{ data: NODE_CATALOG[type].defaults, id, type, position }`); settings
  // edited with `updateNodeData`, one node resized with `updateNode`; eleven
  // edges added as the canvas adds them (`{ id, source, sourceHandle, target,
  // targetHandle, type: "animated" }`); and the file written with the body of
  // `exportFlowData` at 22ac4da, `JSON.stringify({ meta, data:
  // doc.getFlowData(), version, exportedAt }, null, 2)`. The node schemas,
  // the catalog and `FlowDocument` it ran with were byte-identical to 22ac4da.
  //
  // It is not regenerated. When a node's defaults change, this test says what
  // an export from before the change imports as: change the expected notices
  // here on purpose.
  const text = readFileSync(join(import.meta.dir, "fixtures", "export-at-22ac4da.json"), "utf8");
  const exported = JSON.parse(text) as { data: { nodes: FlowNode[]; edges: FlowEdge[] } };

  test("decodes to the exported flow, with nothing to remark", () => {
    const result = decoded(text);
    expect(result.notices).toEqual([]);
    expect(result.flow.name).toBe("Local Flow");
    expect(result.flow.nodes).toEqual(exported.data.nodes);
    expect(result.flow.edges).toStrictEqual(exported.data.edges);
    expect(result.flow.nodes).toHaveLength(12);
    expect(result.flow.edges).toHaveLength(11);
  });

  test("reads the same file without its version as version 1", () => {
    const { version: _, ...unversioned } = JSON.parse(text);
    expect(decoded(JSON.stringify(unversioned))).toEqual(decoded(text));
  });
});

describe("decodeFlowFile: the file's version", () => {
  test("refuses a file of a version newer than it writes, and says to update", () => {
    const text = fileOf([], [], { version: FLOW_FILE_VERSION + 1 });
    expect(problem(text)).toContain("newer version of Microflow");
    expect(problem(text)).toContain(`file format ${FLOW_FILE_VERSION + 1}`);
  });

  test("refuses a version that is not a version", () => {
    for (const version of [0, -1, 1.5, "1", null, {}, [1]]) {
      expect(problem(fileOf([], [], { version }))).toBe(
        "This file is not a Microflow flow: its version is not a flow file version.",
      );
    }
  });
});

describe("decodeFlowFile: text that cannot be a flow", () => {
  test("refuses text that is not JSON", () => {
    for (const text of ["", "not json", '{"data":', "<html></html>"]) {
      expect(problem(text)).toBe("This file is not a Microflow flow: it is not valid JSON.");
    }
  });

  test("refuses JSON of another shape", () => {
    const shapes: unknown[] = [
      null,
      7,
      "flow",
      [],
      {},
      { data: null },
      { data: {} },
      { data: { nodes: [] } },
      { data: { nodes: {}, edges: [] } },
      // Nodes and edges at the top level: never a format of this file.
      { nodes: [], edges: [] },
    ];
    for (const shape of shapes) {
      expect(problem(JSON.stringify(shape))).toBe("This file is not a Microflow flow: it has no nodes and edges.");
    }
  });

  test("refuses a node that is not an object or cannot be told from the others, and names it", () => {
    const led = node("led", "Led");
    const cases: Array<[unknown, string]> = [
      ["led", "node 2 is not a node"],
      [null, "node 2 is not a node"],
      [[led], "node 2 is not a node"],
      [{ ...led, id: undefined }, "node 2 has no id"],
      [{ ...led, id: "" }, "node 2 has no id"],
      [{ ...led, id: 7 }, "node 2 has no id"],
      [{ ...led, id: "first" }, 'two nodes share the id "first"'],
    ];
    for (const [second, what] of cases) {
      expect(problem(fileOf([node("first", "Interval"), second], []))).toBe(`This flow file is damaged: ${what}.`);
    }
  });

  test("refuses an edge that is not an object, has no id or has no ends, and names it", () => {
    const nodes = [node("a", "Interval"), node("b", "Led")];
    const wire = edge("e", "a", "event", "b", "toggle");
    const cases: Array<[unknown, string]> = [
      [7, "edge 2 is not an edge"],
      [{ ...wire, id: undefined }, "edge 2 has no id"],
      [{ ...wire, id: "e2", source: undefined }, 'edge "e2" has no source node'],
      [{ ...wire, id: "e2", target: 3 }, 'edge "e2" has no target node'],
      [wire, 'two edges share the id "e"'],
    ];
    for (const [second, what] of cases) {
      expect(problem(fileOf(nodes, [wire, second]))).toBe(`This flow file is damaged: ${what}.`);
    }
  });
});

describe("decodeFlowFile: a file beyond the limits", () => {
  test("refuses a file larger than 64 MB, also before it is read", () => {
    const refusal = { ok: false, problem: "This file is not a Microflow flow: it is larger than 64 MB." } as const;
    expect(refuseFlowFileOfSize(MAX_FLOW_FILE_SIZE + 1)).toEqual(refusal);
    expect(refuseFlowFileOfSize(MAX_FLOW_FILE_SIZE)).toBeNull();
    expect(decodeFlowFile(" ".repeat(MAX_FLOW_FILE_SIZE + 1))).toEqual(refusal);
  });

  test("refuses more nodes or edges than a flow has, without reading them", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `n${index}` }));
    expect(problem(fileOf(many(5_001), []))).toBe(
      "This file is not a Microflow flow: it has 5001 nodes, and a flow has at most 5000.",
    );
    expect(problem(fileOf([], many(20_001)))).toBe(
      "This file is not a Microflow flow: it has 20001 edges, and a flow has at most 20000.",
    );

    expect(problem(fileOf(many(100_000), []))).toContain("it has 100000 nodes");

    // Counted before any of them is looked at: what would make the file
    // damaged is not found.
    expect(problem(fileOf(["not a node", ...many(5_000)], []))).toBe(
      "This file is not a Microflow flow: it has 5001 nodes, and a flow has at most 5000.",
    );
    expect(problem(fileOf([], [7, ...many(20_000)]))).toBe(
      "This file is not a Microflow flow: it has 20001 edges, and a flow has at most 20000.",
    );
  });

  test("refuses content nested deeper than 64 levels, wherever it is, instead of overflowing", () => {
    const nested = (depth: number) => `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
    const refusal = "This file is not a Microflow flow: its content is nested more than 64 levels deep.";
    const withSettings = (settings: string) =>
      `{"data":{"nodes":[{"id":"n","type":"Led","position":{"x":0,"y":0},"data":{"deep":${settings}}}],"edges":[]}}`;

    expect(problem(withSettings(nested(20_000)))).toBe(refusal);
    expect(problem(`{"data":{"nodes":[],"edges":[]},"extra":${nested(20_000)}}`)).toBe(refusal);
    // Not echoed into the refusal either.
    expect(problem(`{"data":{"nodes":[],"edges":[]},"version":${nested(20_000)}}`)).toBe(
      "This file is not a Microflow flow: its version is not a flow file version.",
    );

    // Far more than settings ever nest, and still a flow.
    const result = decoded(withSettings(nested(40)));
    expect(result.flow.nodes[0].data.deep).toEqual(JSON.parse(nested(40)));
  });

  // The time of a decode is bounded because a flow's size is, and because the
  // time follows the size: 64 times the flow takes about 64 to 110 times as
  // long (the document's store looks its items up by a binary search, so a
  // little more than linear). Work that grew with the square of the flow would
  // take 4096 times as long. The test measures that growth and no duration: a
  // slow machine is slow for both files alike. What it measures is the
  // processor time the decode used, not the time that passed, so the time this
  // process spends waiting for a busy machine is not in it. The small file is
  // decoded once first, untimed, so the compiler's warm-up is in neither
  // measure; then each file is decoded three times, in turns, and its cheapest
  // decode counts. The timeout only lets a busy machine finish.
  test("decodes the largest flow it accepts, in time that follows the size of the flow", () => {
    const led = node("led", "Led");
    const flowOf = (nodeCount: number, edgeCount: number) =>
      fileOf(
        Array.from({ length: nodeCount }, (_, index) => ({ ...led, id: `n${index}` })),
        Array.from({ length: edgeCount }, (_, index) =>
          edge(`e${index}`, `n${index % nodeCount}`, "value", `n${(index + 1) % nodeCount}`, "value"),
        ),
      );
    const largest = flowOf(5_000, 20_000);
    const small = flowOf(78, 312);
    const timed = (text: string): { result: DecodedFlowFile; took: number } => {
      const before = process.cpuUsage();
      const result = decodeFlowFile(text);
      const used = process.cpuUsage(before);
      return { result, took: used.user + used.system };
    };

    timed(small);
    let result: DecodedFlowFile | undefined;
    let leastSmall = Infinity;
    let leastLargest = Infinity;
    for (let round = 0; round < 3; round++) {
      leastSmall = Math.min(leastSmall, timed(small).took);
      const decoding = timed(largest);
      leastLargest = Math.min(leastLargest, decoding.took);
      result = decoding.result;
    }

    if (!result?.ok) throw new Error("expected the largest flow to decode");
    expect(result.flow.nodes).toHaveLength(5_000);
    expect(result.flow.edges).toHaveLength(20_000);
    expect(result.notices).toEqual([]);
    // Measured: 76 to 112. Quadratic is 4096. The line is a factor of eight
    // below quadratic and more than four above what was measured.
    expect(leastLargest / leastSmall).toBeLessThan(512);
  }, 60_000);
});

describe("decodeFlowFile: nodes", () => {
  test("a node without a usable type, position or size becomes what the document makes of it, and each is said", () => {
    const led = node("led", "Led");
    const result = decoded(
      fileOf(
        [
          { ...led, id: "no-type", type: undefined },
          { ...led, id: "empty-type", type: "" },
          { ...led, id: "odd-type", type: 7 },
          { ...led, id: "no-position", position: undefined },
          { ...led, id: "half-position", position: { x: 120, y: "low" } },
          { ...led, id: "odd-size", width: "wide", height: null },
        ],
        [],
      ),
    );

    const byId = new Map(result.flow.nodes.map((n) => [n.id, n]));
    expect(byId.get("no-type")).toEqual({ ...led, id: "no-type", type: "" });
    expect(byId.get("empty-type")).toEqual({ ...led, id: "empty-type", type: "" });
    expect(byId.get("odd-type")).toEqual({ ...led, id: "odd-type", type: "" });
    expect(byId.get("no-position")).toEqual({ ...led, id: "no-position", position: { x: 0, y: 0 } });
    expect(byId.get("half-position")).toEqual({ ...led, id: "half-position", position: { x: 120, y: 0 } });
    expect(byId.get("odd-size")).toEqual({ ...led, id: "odd-size" });

    expect(result.notices).toEqual([
      { kind: "unknown-node-type", id: "no-type", message: 'Node "no-type" has no type in the file. It is kept, but it will not run.' },
      { kind: "unknown-node-type", id: "empty-type", message: 'Node "empty-type" has no type in the file. It is kept, but it will not run.' },
      { kind: "unknown-node-type", id: "odd-type", message: 'Node "odd-type" has no type in the file. It is kept, but it will not run.' },
      { kind: "position-defaulted", id: "no-position", message: 'Node "no-position" had no usable position in the file; it is placed at 0, 0.' },
      { kind: "position-defaulted", id: "half-position", message: 'Node "half-position" had no usable position in the file; it is placed at 120, 0.' },
    ]);
  });

  test("a node whose settings are not an object starts from the defaults, and that is said", () => {
    const led = node("led", "Led");
    for (const data of [null, ["pin", 13], "pin 13", 13]) {
      const result = decoded(fileOf([{ ...led, data }], []));
      expect(result.flow.nodes).toEqual([led]);
      expect(result.notices).toEqual([
        {
          kind: "settings-defaulted",
          id: "led",
          message: 'Led "led" had settings in the file that are not settings; the defaults are used.',
        },
      ]);
    }
  });

  test("a node without a type whose settings are not an object is called a node", () => {
    const result = decoded(fileOf([{ id: "x", position: { x: 0, y: 0 }, data: "pin 13" }], []));
    expect(result.flow.nodes).toEqual([{ id: "x", type: "", position: { x: 0, y: 0 }, data: {} }]);
    expect(result.notices).toEqual([
      { kind: "unknown-node-type", id: "x", message: 'Node "x" has no type in the file. It is kept, but it will not run.' },
      { kind: "settings-defaulted", id: "x", message: 'Node "x" had settings in the file that are not settings; it has none.' },
    ]);
  });

  test("a node without settings gets the defaults", () => {
    const { data: _, ...bare } = node("led", "Led");
    const result = decoded(fileOf([bare], []));
    expect(result.flow.nodes).toEqual([node("led", "Led")]);
    expect(result.notices).toEqual([
      { kind: "settings-defaulted", id: "led", message: 'Led "led" had no settings in the file; the defaults are used.' },
    ]);
  });

  test("whatever the file's nodes are, the decoded ones are what the document gives back for them", () => {
    const led = node("led", "Led");
    const result = decoded(
      fileOf(
        [
          { id: "bare" },
          { id: "junk", type: { a: 1 }, position: "left", data: null, width: -Infinity, height: "tall" },
          { ...led, position: { x: 1, y: 2, z: 3 }, data: { ...led.data, selected: true, dragging: true } },
          { id: "alien", type: "NotYetInvented", position: [5, 6], data: { level: 3 } },
        ],
        [],
      ),
    );
    expect(JSON.parse(JSON.stringify(result.flow.nodes))).toEqual(asLanded(result.flow.nodes).nodes);
  });

  test("keeps a node of a type this build does not know, with its edges, and says so", () => {
    const alien = { id: "x", type: "NotYetInvented", position: { x: 5, y: 6 }, data: { level: 3 } };
    const wire = edge("e", "a", "event", "x", "in");
    const result = decoded(fileOf([node("a", "Interval"), alien], [wire]));

    expect(result.flow.nodes[1]).toEqual(alien);
    expect(result.flow.edges).toEqual([wire]);
    expect(result.notices).toEqual([
      {
        kind: "unknown-node-type",
        id: "x",
        message:
          'Node "x" has the type "NotYetInvented", which this version of Microflow does not know. ' +
          "It is kept, but it will not run.",
      },
    ]);
  });

  test("gives a setting the file lacks its default, and says which", () => {
    const { pin: _, ...withoutPin } = node("led", "Led").data;
    const result = decoded(fileOf([{ ...node("led", "Led"), data: withoutPin }], []));

    expect(result.flow.nodes[0].data).toEqual(node("led", "Led").data);
    expect(result.notices).toEqual([
      { kind: "settings-defaulted", id: "led", message: 'LED "led" had no "pin" in the file; the default is used.' },
    ]);
  });

  test("names the first few missing settings and counts the rest", () => {
    const result = decoded(fileOf([{ ...node("led", "Led"), data: { label: "Lamp" } }], []));
    expect(result.flow.nodes[0].data).toEqual({ ...node("led", "Led").data, label: "Lamp" });
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0].message).toMatch(/^Lamp "led" had no ("\w+", ){4}"\w+" and \d+ more in the file; the default is used\.$/);
  });

  test("completes a nested setting without touching what is there", () => {
    const servo = node("servo", "Servo");
    const result = decoded(fileOf([{ ...servo, data: { ...servo.data, range: { min: 20 } } }], []));

    expect(result.flow.nodes[0].data.range).toEqual({ min: 20, max: 180 });
    expect(result.notices).toEqual([
      { kind: "settings-defaulted", id: "servo", message: 'Servo "servo" had no "range.max" in the file; the default is used.' },
    ]);
  });

  test("keeps a setting the node's schema does not name, at the top or nested, without a remark", () => {
    const led = node("led", "Led", { pin: "A3" });
    const servo = node("servo", "Servo");
    const ledData = { ...led.data, calibration: { low: 3, high: [1, 2] } };
    const servoData = { ...servo.data, range: { min: 20, max: 160, step: 5 } };
    const result = decoded(fileOf([{ ...led, data: ledData }, { ...servo, data: servoData }], []));

    expect(result.flow.nodes[0].data).toEqual(ledData);
    expect(result.flow.nodes[1].data).toEqual(servoData);
    expect(result.notices).toEqual([]);
  });

  test("a nested setting the schema does not name is kept while a missing one beside it is completed", () => {
    const servo = node("servo", "Servo");
    const result = decoded(fileOf([{ ...servo, data: { ...servo.data, range: { min: 20, step: 5 } } }], []));

    expect(result.flow.nodes[0].data.range).toEqual({ min: 20, step: 5, max: 180 });
    expect(notices(fileOf([{ ...servo, data: { ...servo.data, range: { min: 20, step: 5 } } }], []))).toEqual([
      { kind: "settings-defaulted", id: "servo" },
    ]);
  });

  test("keeps a stale value exactly as the file has it, and says the node needs a look", () => {
    // The persistence trap: a select once stored its label, not its value, and
    // documents still hold those. The app opens such a flow; so does import.
    const mqtt = node("mqtt", "Mqtt");
    const { retain: _, ...data } = { ...mqtt.data, qos: "At least once (1)" };
    const result = decoded(fileOf([{ ...mqtt, data }, node("led", "Led")], []));

    // Not even the missing `retain` is filled in: the settings stand as they are.
    expect(result.flow.nodes[0].data).toEqual(data);
    expect(result.notices.map(({ kind, id }) => ({ kind, id }))).toEqual([{ kind: "settings-unrecognised", id: "mqtt" }]);
    expect(result.notices[0].message).toStartWith(
      'The settings of MQTT "mqtt" are kept as they are in the file, but this version of Microflow does not accept them (qos: ',
    );
  });

  test("settings of the wrong shape are kept, and so are the node's edges", () => {
    const junk: Array<[ComponentType, Record<string, unknown>]> = [
      ["Llm", { prompt: 123 }],
      ["Function", { code: 5 }],
      ["Music", { tracks: {} }],
      ["Music", { tracks: [null] }],
      ["Music", { tracks: [{}] }],
      ["Figma", { resolvedType: "toString" }],
    ];
    const nodes = [
      node("counter", "Counter"),
      ...junk.map(([type, data], index) => ({ id: `junk-${index}`, type, position: { x: 0, y: 0 }, data })),
    ];
    const edges = junk.flatMap((_, index) => [
      edge(`in-${index}`, "counter", "value", `junk-${index}`, "trigger"),
      edge(`out-${index}`, `junk-${index}`, "value", "counter", "set"),
    ]);

    const result = decoded(fileOf(nodes, edges));

    expect(result.flow.nodes).toEqual(nodes);
    expect(result.flow.edges).toEqual(edges);
    const aboutSettings = result.notices.filter(({ kind }) => kind.startsWith("settings-"));
    expect(aboutSettings.map(({ kind, id }) => ({ kind, id }))).toEqual(
      junk.map((_, index) => ({ kind: "settings-unrecognised", id: `junk-${index}` })),
    );
  });

  test("does not let a node's schema reset settings it cannot read", () => {
    // Compare's schema answers unreadable settings with its own defaults.
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      const compare = node("compare", "Compare");
      const data = { ...compare.data, validator: "number", subValidator: "is equal to", number: 5 };
      const result = decoded(fileOf([{ ...compare, data }], []));

      expect(result.flow.nodes[0].data).toEqual(data);
      expect(result.notices).toEqual([
        {
          kind: "settings-unrecognised",
          id: "compare",
          message:
            'The settings of Compare "compare" are kept as they are in the file, but this version of Microflow ' +
            "does not accept them (it would reset some of them to its defaults).",
        },
      ]);
    } finally {
      quiet.mockRestore();
    }
  });
});

describe("decodeFlowFile: edges", () => {
  test("leaves out an edge to a node that is not in the file, and says which", () => {
    const nodes = [node("a", "Interval"), node("b", "Led")];
    const kept = edge("kept", "a", "event", "b", "toggle");
    const result = decoded(fileOf(nodes, [kept, edge("lost", "a", "event", "ghost", "toggle"), edge("lost-2", "phantom", "event", "b", "toggle")]));

    expect(result.flow.edges).toEqual([kept]);
    expect(result.flow.nodes).toEqual(nodes);
    expect(result.notices).toEqual([
      { kind: "edge-dropped", id: "lost", message: 'The edge from "a" to "ghost" was left out: there is no node "ghost" in the file.' },
      { kind: "edge-dropped", id: "lost-2", message: 'The edge from "phantom" to "b" was left out: there is no node "phantom" in the file.' },
    ]);
  });

  test("an edge to a missing node is left out whatever its other end names, and that is all that is said", () => {
    const result = decoded(fileOf([node("led", "Led")], [edge("e", "led", "sparkle", "ghost", "in")]));
    expect(result.flow.edges).toEqual([]);
    expect(notices(fileOf([node("led", "Led")], [edge("e", "led", "sparkle", "ghost", "in")]))).toEqual([
      { kind: "edge-dropped", id: "e" },
    ]);
  });

  test("edges at a handle their node declares and does not offer are kept, and mentioned once", () => {
    const nodes = [
      // A publishing Mqtt node does not offer `value`; a subscribing one does.
      node("mqtt", "Mqtt", { direction: "publish" }),
      node("monitor", "Monitor"),
      node("pot", "Potentiometer"),
      // No settings make a Servo offer `rotate`; the runtime takes it.
      node("servo", "Servo", { type: "continuous" }),
    ];
    const otherSettings = edge("e1", "mqtt", "value", "monitor", "value");
    const never = edge("e2", "pot", "value", "servo", "rotate");

    const one = decoded(fileOf(nodes, [otherSettings]));
    expect(one.flow.edges).toEqual([otherSettings]);
    expect(one.notices).toEqual([
      {
        kind: "edges-not-drawn",
        message:
          "1 edge is kept that the canvas does not show: it uses a handle its node hides as it is set up. " +
          "It still works when the flow runs.",
      },
    ]);

    const two = decoded(fileOf(nodes, [otherSettings, never]));
    expect(two.flow.edges).toEqual([otherSettings, never]);
    expect(two.notices).toEqual([
      {
        kind: "edges-not-drawn",
        message:
          "2 edges are kept that the canvas does not show: they use handles their nodes hide as they are set up. " +
          "They still work when the flow runs.",
      },
    ]);
  });

  test("keeps an edge at a handle nothing declares, and says it carries nothing", () => {
    const nodes = [node("a", "Interval"), node("led", "Led")];
    const wire = edge("e", "a", "event", "led", "sparkle");
    const result = decoded(fileOf(nodes, [wire]));

    expect(result.flow.edges).toEqual([wire]);
    expect(result.notices).toEqual([
      {
        kind: "unknown-handle",
        id: "e",
        message:
          'The edge from "a" to "led" is kept, but it carries nothing and the canvas cannot show it: ' +
          'as LED "led" is set up, it has no input "sparkle".',
      },
    ]);
  });

  test("an unknown handle at the target is said whatever the source end is", () => {
    const led = node("led", "Led");
    const toSparkle = (source: string, sourceHandle: string) => edge("e", source, sourceHandle, "led", "sparkle");
    const targetNotice = { kind: "unknown-handle", id: "e" };

    // The source end is declared and not offered.
    const hidden = decoded(fileOf([node("mqtt", "Mqtt", { direction: "publish" }), led], [toSparkle("mqtt", "value")]));
    expect(hidden.flow.edges).toHaveLength(1);
    expect(hidden.notices.map(({ kind, id }) => ({ kind, id }))).toEqual([targetNotice]);
    expect(hidden.notices[0].message).toEndWith('as LED "led" is set up, it has no input "sparkle".');

    // The source end is a node of an unknown type.
    const alien = { id: "x", type: "NotYetInvented", position: { x: 0, y: 0 }, data: {} };
    expect(notices(fileOf([alien, led], [toSparkle("x", "out")]))).toEqual([
      { kind: "unknown-node-type", id: "x" },
      targetNotice,
    ]);

    // Both ends name a handle nothing declares: one notice for each.
    const both = decoded(fileOf([node("a", "Interval"), led], [toSparkle("a", "glitter")]));
    expect(both.notices.map(({ kind, id }) => ({ kind, id }))).toEqual([targetNotice, targetNotice]);
    expect(both.notices[0].message).toEndWith('as Interval "a" is set up, it has no output "glitter".');
    expect(both.notices[1].message).toEndWith('as LED "led" is set up, it has no input "sparkle".');
  });

  test("keeps an edge at a variable the code no longer names", () => {
    const nodes = [node("counter", "Counter"), node("fn", "Function", { code: "return {{speed}};" })];
    const wire = edge("e", "counter", "value", "fn", "gain");
    const result = decoded(fileOf(nodes, [wire]));

    expect(result.flow.edges).toEqual([wire]);
    expect(notices(fileOf(nodes, [wire]))).toEqual([{ kind: "unknown-handle", id: "e" }]);
  });

  test("leaves out an edge that names no handle, and says so; the rest of the flow is there", () => {
    const nodes = [node("btn", "Button"), node("led", "Led")];
    const wired = edge("wired", "btn", "event", "led", "toggle");
    const result = decoded(fileOf(nodes, [{ id: "e", source: "btn", target: "led" }, wired]));

    expect(result.flow.nodes).toEqual(nodes);
    expect(result.flow.edges).toEqual([wired]);
    expect(result.notices).toEqual([
      {
        kind: "edge-dropped",
        id: "e",
        message: 'The edge from "btn" to "led" was left out: it names no output of "btn" and no input of "led".',
      },
    ]);
  });

  test("a handle that is not a name is no handle, at either end", () => {
    const nodes = [node("btn", "Button"), node("led", "Led")];
    for (const handle of [null, undefined, "", 3, true, { x: 1 }, ["event"]]) {
      const noOutput = decoded(fileOf(nodes, [{ id: "e", source: "btn", sourceHandle: handle, target: "led", targetHandle: "toggle" }]));
      expect(noOutput.flow.edges).toEqual([]);
      expect(noOutput.notices).toEqual([
        { kind: "edge-dropped", id: "e", message: 'The edge from "btn" to "led" was left out: it names no output of "btn".' },
      ]);

      const noInput = decoded(fileOf(nodes, [{ id: "e", source: "btn", sourceHandle: "event", target: "led", targetHandle: handle }]));
      expect(noInput.flow.edges).toEqual([]);
      expect(noInput.notices).toEqual([
        { kind: "edge-dropped", id: "e", message: 'The edge from "btn" to "led" was left out: it names no input of "led".' },
      ]);
    }
  });

  test("an edge that names no handle is left out whatever its nodes are", () => {
    // A node of an unknown type keeps the edges that name a handle of it: its
    // handles are unknown. An edge that names none has nothing to keep.
    const alien = { id: "x", type: "NotYetInvented", position: { x: 0, y: 0 }, data: {} };
    const named = edge("named", "x", "out", "led", "toggle");
    const result = decoded(fileOf([alien, node("led", "Led")], [named, { id: "e", source: "x", target: "led", targetHandle: "toggle" }]));
    expect(result.flow.edges).toEqual([named]);
    expect(result.notices.map(({ kind, id }) => ({ kind, id }))).toEqual([
      { kind: "unknown-node-type", id: "x" },
      { kind: "edge-dropped", id: "e" },
    ]);

    // A node that is not in the file is the one thing said about its edge.
    const dangling = decoded(fileOf([node("led", "Led")], [{ id: "e", source: "ghost", target: "led" }]));
    expect(dangling.notices).toEqual([
      { kind: "edge-dropped", id: "e", message: 'The edge from "ghost" to "led" was left out: there is no node "ghost" in the file.' },
    ]);
  });

  test("an edge is its id, its ends, its handles and its type: nothing else on it is taken over", () => {
    const nodes = [node("a", "Interval"), node("b", "Led")];
    // What the canvas and Ask AI write for an edge.
    const written = { ...edge("e", "a", "event", "b", "toggle"), type: "animated" };
    const result = decoded(
      fileOf(nodes, [
        {
          ...written,
          selected: true,
          animated: "yes",
          hidden: true,
          style: "stroke: red",
          label: { text: "wire" },
          data: { weight: 3 },
          zIndex: "top",
          markerEnd: 7,
          className: ["a"],
          interactionWidth: null,
        },
      ]),
    );

    expect(result.flow.edges).toStrictEqual([written]);
    expect(result.notices).toEqual([]);
  });

  test("a type the app does not give an edge is dropped from it, and the edge kept", () => {
    const nodes = [node("a", "Interval"), node("b", "Led")];
    const wire = edge("e", "a", "event", "b", "toggle");
    for (const type of ["nope", "default", "", 7, null, { animated: true }]) {
      const result = decoded(fileOf(nodes, [{ ...wire, type }]));
      expect(result.flow.edges).toStrictEqual([wire]);
      expect(result.notices).toEqual([]);
    }
  });

  test("an edge at an open port its node's settings name is an ordinary edge", () => {
    const nodes = [
      node("counter", "Counter"),
      node("fn", "Function", { code: "return {{speed}} * 2;" }),
      node("music", "Music", { tracks: [{ name: "intro", src: "" }] }),
    ];
    const edges = [edge("e1", "counter", "value", "fn", "speed"), edge("e2", "counter", "value", "music", "intro")];
    const result = decoded(fileOf(nodes, edges));

    expect(result.flow.edges).toEqual(edges);
    expect(result.notices).toEqual([]);
  });
});

describe("decodeFlowFile: the flow's name", () => {
  test("is the file's, trimmed; a file without one gives none", () => {
    expect(decoded(fileOf([], [], { meta: { name: "  My flow " } })).flow.name).toBe("My flow");
    for (const meta of [undefined, {}, { name: "" }, { name: "   " }, { name: 7 }, "Blink"]) {
      expect(decoded(fileOf([], [], { meta })).flow).not.toHaveProperty("name");
    }
  });

  test("is cut to the 100 characters a flow's name may have, and that is said", () => {
    const exact = "n".repeat(100);
    expect(decoded(fileOf([], [], { meta: { name: exact } }))).toEqual({
      ok: true,
      flow: { name: exact, nodes: [], edges: [] },
      notices: [],
    });

    const long = decoded(fileOf([], [], { meta: { name: `${"n".repeat(98)} 🌱🌱🌱` } }));
    // Cut on a whole character, with no space left at the end.
    expect(long.flow.name).toBe("n".repeat(98));
    expect(decoded(fileOf([], [], { meta: { name: `${"n".repeat(97)}🌱🌱🌱` } })).flow.name).toBe(`${"n".repeat(97)}🌱`);
    expect(long.notices).toEqual([
      { kind: "name-shortened", message: "The flow's name was longer than 100 characters and was shortened." },
    ]);
  });
});

describe("decodeFlowFile: what a message carries of the file", () => {
  const huge = "x".repeat(100_000);

  test("a refusal shows the start of a long id, not all of it", () => {
    const twice = { id: huge, type: "Led", position: { x: 0, y: 0 }, data: {} };
    expect(problem(fileOf([twice, twice], []))).toBe(
      `This flow file is damaged: two nodes share the id "${"x".repeat(40)}…".`,
    );
    expect(problem(fileOf([], [{ id: huge }]))).toBe(
      `This flow file is damaged: edge "${"x".repeat(40)}…" has no source node.`,
    );
  });

  test("a notice shows the start of a long id, type, label, handle or setting name", () => {
    const result = decoded(
      fileOf(
        [
          { id: huge, type: huge, position: { x: 0, y: 0 }, data: {} },
          { ...node("led", "Led"), data: { label: huge, [huge]: { deep: 1 } } },
          { ...node("servo", "Servo"), data: { ...node("servo", "Servo").data, range: {} } },
        ],
        [edge("e", "led", huge, "ghost", "in"), edge("e2", "led", huge, "servo", huge)],
      ),
    );
    expect(result.notices.length).toBeGreaterThanOrEqual(5);
    for (const { message } of result.notices) expect(message.length).toBeLessThan(400);
  });
});
