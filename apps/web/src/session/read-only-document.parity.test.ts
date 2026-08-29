import { describe, expect, test } from "bun:test";
import { FlowDocument } from "@microflow/collab";
import { MUTATORS, readOnlyDocument } from "./read-only-document";

/**
 * A parity guard, in the spirit of the Catalog Parity Guard: `readOnlyDocument`
 * enforces Viewer access by listing the methods it neutralises, and a list is
 * only as good as the thing that notices when it drifts.
 *
 * Rather than trusting a hand-maintained set, this calls every method on
 * `FlowDocument` and asks the document whether it changed. Anything that writes
 * and is not in `MUTATORS` is a silent hole in Viewer enforcement — which is
 * exactly what adding `setNode` and `deleteNode` (ADR-0017) would have opened
 * if nobody had remembered.
 */

/** Methods that read, observe or serialise — never write the document. */
const KNOWN_READS = new Set<string>([
  "constructor",
  "getNodes",
  "getNode",
  "getNodeIds",
  "hasNode",
  "getEdges",
  "getEdge",
  "getEdgeIds",
  "hasEdge",
  "getMeta",
  "getFlowData",
  "canUndo",
  "canRedo",
  "clearHistory",
  "onNodesChange",
  "onEdgesChange",
  "onMetaChange",
  "onAnyChange",
  "encode",
  "destroy",
]);

/** A plausible argument for each method, so calling it actually does its job. */
function argsFor(name: string): unknown[] {
  const node = { id: "probe", type: "Led", position: { x: 1, y: 2 }, data: { a: 1 } };
  const edge = { id: "probe-e", source: "probe", target: "probe" };
  switch (name) {
    case "addNode":
    case "setNode":
      return [node];
    case "updateNode":
      return ["seed", { type: "Button" }];
    case "updateNodePosition":
      return ["seed", { x: 9, y: 9 }];
    case "updateNodeData":
      return ["seed", { changed: true }];
    case "removeNode":
    case "deleteNode":
      return ["seed"];
    case "addEdge":
    case "setEdge":
      return [edge];
    case "updateEdge":
      return ["seed-e", { target: "z" }];
    case "removeEdge":
      return ["seed-e"];
    case "setFlowData":
      return [[node], [edge]];
    case "setMeta":
      return [{ name: "changed" }];
    default:
      return [];
  }
}

function seeded(): FlowDocument {
  const doc = FlowDocument.createEmpty();
  doc.addNode({ id: "seed", type: "Led", position: { x: 0, y: 0 }, data: { label: "x" } });
  doc.addEdge({ id: "seed-e", source: "seed", target: "seed" });
  doc.setMeta({ name: "seed" });
  return doc;
}

/** Every method name on the prototype, minus the known read surface. */
function candidateMethods(): string[] {
  return Object.getOwnPropertyNames(FlowDocument.prototype).filter((name) => {
    if (KNOWN_READS.has(name)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(FlowDocument.prototype, name);
    return typeof descriptor?.value === "function";
  });
}

describe("readOnlyDocument mutator parity", () => {
  test("every method that writes the document is listed in MUTATORS", () => {
    const writesButUnguarded: string[] = [];

    for (const name of candidateMethods()) {
      const doc = seeded();
      const before = doc.encode();

      try {
        (doc as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!(
          ...argsFor(name),
        );
      } catch {
        // A method that throws on a probe argument is not evidence either way.
        continue;
      }

      const changed = !Buffer.from(doc.encode()).equals(Buffer.from(before));
      if (changed && !MUTATORS.has(name)) writesButUnguarded.push(name);
    }

    expect(writesButUnguarded).toEqual([]);
  });

  test("MUTATORS lists nothing that does not exist", () => {
    const missing = Array.from(MUTATORS).filter(
      (name) => typeof (FlowDocument.prototype as never)[name as never] !== "function",
    );
    expect(missing).toEqual([]);
  });

  test("the new ADR-0017 write methods are actually neutralised", () => {
    const doc = seeded();
    const guarded = readOnlyDocument(doc);

    guarded.setNode({ id: "seed", type: "Led", position: { x: 99, y: 99 }, data: {} });
    guarded.deleteNode("seed");
    guarded.setEdge({ id: "seed-e", source: "a", target: "b" });

    expect(doc.getNode("seed")!.position).toEqual({ x: 0, y: 0 });
    expect(doc.hasNode("seed")).toBe(true);
    expect(doc.getEdge("seed-e")!.target).toBe("seed");
  });
});
