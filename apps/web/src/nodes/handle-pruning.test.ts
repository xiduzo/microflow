// The session removes the edges of a handle that vanishes; it is handed
// `nodeHandles` to know what a node's handles are (`main.tsx`). These tests put
// the two together the way the app does: a session, the real Handle Rules, and
// edits to the document only. No canvas, no mounted node.
//
// How the session prunes (undo, peers, loading) is the session's to test, with
// a stand-in for the rules: `session/handle-pruning.test.ts`.

// `createLocalSession` opens the local flow's store.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as Y from "yjs";
import type { FlowDocument, FlowEdge, FlowNode } from "@microflow/collab";
import { createLocalSession, provideHandleSets, type FlowSession } from "@/session";
import { nodeHandles } from "./handles";

const node = (id: string, type: string, data: Record<string, unknown> = {}): FlowNode => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data,
});

const edge = (
  id: string,
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
): FlowEdge => ({ id, source, sourceHandle, target, targetHandle });

let session: FlowSession;

beforeEach(() => provideHandleSets(nodeHandles));
afterEach(() => {
  session?.destroy();
  provideHandleSets(null);
});

/** An editable session whose flow holds `nodes` and `edges`. */
function editing(nodes: FlowNode[], edges: FlowEdge[]): FlowDocument {
  session = createLocalSession();
  const { doc } = session;
  doc.doc.transact(() => {
    for (const n of nodes) doc.addNode(n);
    for (const e of edges) doc.addEdge(e);
  }, "seed");
  return doc;
}

const edgeIds = (doc: FlowDocument) => doc.getEdgeIds().sort();

/** A counter to wire from, and a monitor to wire to: neither ever changes. */
const SOURCE = node("src", "Counter");
const SINK = node("sink", "Monitor");

describe("a setting that takes a handle off a node takes its edges too", () => {
  test("Function: a removed {{variable}} loses its edge, the ones still in the code keep theirs", () => {
    const doc = editing(
      [SOURCE, node("fn", "Function", { code: "return {{a}} + {{b}};" })],
      [
        edge("to-a", "src", "value", "fn", "a"),
        edge("to-b", "src", "value", "fn", "b"),
        edge("to-trigger", "src", "value", "fn", "trigger"),
      ],
    );

    doc.updateNodeData("fn", { code: "return {{a}} + {{c}};" });

    expect(edgeIds(doc)).toEqual(["to-a", "to-trigger"]);
  });

  test("Llm: a removed {{variable}} loses its edge, the ones still in the prompt keep theirs", () => {
    const doc = editing(
      [SOURCE, node("llm", "Llm", { prompt: "Say {{greeting}} to {{name}}" })],
      [
        edge("to-greeting", "src", "value", "llm", "greeting"),
        edge("to-name", "src", "value", "llm", "name"),
      ],
    );

    doc.updateNodeData("llm", { prompt: "Say hello to {{name}}, {{title}}" });

    expect(edgeIds(doc)).toEqual(["to-name"]);
  });

  test("Music: a removed record loses its edge", () => {
    const tracks = [
      { name: "intro", src: "data:audio/mp3;base64,AA" },
      { name: "outro", src: "data:audio/mp3;base64,AA" },
    ];
    const doc = editing(
      [SOURCE, node("music", "Music", { tracks })],
      [
        edge("to-intro", "src", "value", "music", "intro"),
        edge("to-outro", "src", "value", "music", "outro"),
        edge("to-play", "src", "value", "music", "play"),
      ],
    );

    doc.updateNodeData("music", { tracks: [tracks[1]] });

    expect(edgeIds(doc)).toEqual(["to-outro", "to-play"]);
  });

  test("Mqtt: switching direction removes the edge of the direction it left", () => {
    const doc = editing(
      [SOURCE, SINK, node("mqtt", "Mqtt", { direction: "publish" })],
      [edge("to-trigger", "src", "value", "mqtt", "trigger")],
    );

    doc.updateNodeData("mqtt", { direction: "subscribe" });
    expect(edgeIds(doc)).toEqual([]);

    doc.addEdge(edge("from-value", "mqtt", "value", "sink", "value"));
    doc.updateNodeData("mqtt", { direction: "publish" });
    expect(edgeIds(doc)).toEqual([]);
  });

  test("Midi: switching mode or direction removes the edges of the handles it left", () => {
    const doc = editing(
      [SOURCE, SINK, node("midi", "Midi", { direction: "in", mode: "note" })],
      [
        edge("from-note", "midi", "note", "sink", "value"),
        edge("from-on", "midi", "on", "sink", "value"),
      ],
    );

    doc.updateNodeData("midi", { mode: "cc" });
    expect(edgeIds(doc)).toEqual([]);

    doc.addEdge(edge("from-value", "midi", "value", "sink", "value"));
    doc.updateNodeData("midi", { direction: "out" });
    expect(edgeIds(doc)).toEqual([]);

    doc.addEdge(edge("to-send", "src", "value", "midi", "send"));
    doc.updateNodeData("midi", { direction: "in" });
    expect(edgeIds(doc)).toEqual([]);
  });

  test("Servo: only the handles the new type lacks lose their edges", () => {
    const doc = editing(
      [SOURCE, SINK, node("servo", "Servo", { type: "standard" })],
      [
        edge("to-min", "src", "value", "servo", "min"),
        edge("to-max", "src", "value", "servo", "max"),
        edge("to-value", "src", "value", "servo", "value"),
        edge("from-value", "servo", "value", "sink", "value"),
      ],
    );

    doc.updateNodeData("servo", { type: "continuous" });

    // `value` exists as a Port and as an Emit in both types, so both stay.
    expect(edgeIds(doc)).toEqual(["from-value", "to-value"]);
  });

  test("Figma: a variable of another type keeps only the ports both types have", () => {
    const doc = editing(
      [SOURCE, node("figma", "Figma", { resolvedType: "FLOAT" })],
      [
        edge("to-increment", "src", "value", "figma", "increment"),
        edge("to-set", "src", "value", "figma", "set"),
      ],
    );

    doc.updateNodeData("figma", { resolvedType: "STRING" });

    expect(edgeIds(doc)).toEqual(["to-set"]);
  });

  test("Piezo: both types have the same handles, so nothing is removed", () => {
    const doc = editing(
      [SOURCE, node("piezo", "Piezo", { type: "buzz" })],
      [
        edge("to-trigger", "src", "value", "piezo", "trigger"),
        edge("to-stop", "src", "value", "piezo", "stop"),
      ],
    );

    doc.updateNodeData("piezo", { type: "song" });

    expect(edgeIds(doc)).toEqual(["to-stop", "to-trigger"]);
  });
});

describe("an edge is removed when its handle is gone, not when it stops being drawn", () => {
  const variables = (names: string[]) => names.map((name) => `{{${name}}}`).join(" + ");
  const SEVEN = ["a", "b", "c", "d", "e", "f", "g"];

  test.each([
    ["Function", "code"],
    ["Llm", "prompt"],
  ])("%s: a variable pushed past the last drawn port keeps its edge", (type, field) => {
    // Seven fit along the node. An eighth in front pushes `g` out of sight.
    const doc = editing(
      [SOURCE, node("n", type, { [field]: variables(SEVEN) })],
      SEVEN.map((name) => edge(`to-${name}`, "src", "value", "n", name)),
    );

    doc.updateNodeData("n", { [field]: variables(["z", ...SEVEN]) });
    expect(edgeIds(doc)).toEqual(SEVEN.map((name) => `to-${name}`));

    // Taking a variable out of the text is what removes its edge.
    doc.updateNodeData("n", { [field]: variables(["z", ...SEVEN.slice(0, 6)]) });
    expect(edgeIds(doc)).toEqual(SEVEN.slice(0, 6).map((name) => `to-${name}`));
  });

  test("Music: a record beyond the drawn ones keeps its edge until it is removed", () => {
    const tracks = Array.from({ length: 10 }, (_, i) => ({ name: `song ${i}`, src: "" }));
    const doc = editing(
      [SOURCE, node("music", "Music", { tracks })],
      [edge("to-last", "src", "value", "music", "song 9")],
    );

    doc.updateNodeData("music", { tracks: [{ name: "new", src: "" }, ...tracks] });
    expect(edgeIds(doc)).toEqual(["to-last"]);

    doc.updateNodeData("music", { tracks: tracks.slice(0, 9) });
    expect(edgeIds(doc)).toEqual([]);
  });
});

describe("settings no schema would allow", () => {
  test("an update that carries them applies, and takes no edge of a handle that is still there", () => {
    const doc = editing(
      [
        SOURCE,
        node("llm", "Llm", { prompt: "Say {{greeting}}" }),
        node("music", "Music", { tracks: [{ name: "intro", src: "" }] }),
        node("figma", "Figma", { resolvedType: "FLOAT" }),
      ],
      [
        edge("to-trigger", "src", "value", "llm", "trigger"),
        edge("to-play", "src", "value", "music", "play"),
        edge("to-set", "src", "value", "figma", "set"),
      ],
    );

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc.doc));
    const data = (id: string) =>
      (peer.getMap("nodes").get(id) as Y.Map<unknown>).get("data") as Y.Map<unknown>;
    data("llm").set("prompt", 123);
    data("music").set("tracks", [null, {}, { name: null }]);
    data("figma").set("resolvedType", "toString");
    const update = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc.doc));

    expect(() => Y.applyUpdate(doc.doc, update, "provider")).not.toThrow();
    expect(doc.getNode("llm")?.data.prompt).toBe(123);
    expect(edgeIds(doc)).toEqual(["to-play", "to-set", "to-trigger"]);
  });
});
