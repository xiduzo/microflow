/**
 * How much does one peer's edit cost every other peer's canvas?
 *
 * ReactFlow memoises a node's render on the identity of its node object, so
 * the number of node objects whose identity changes on a remote update is a
 * direct proxy for the number of node components React re-renders. That count
 * is what this measures, alongside wall time.
 *
 * Run: bun run bench (from apps/web)
 */

import { FlowDocument, type FlowNode } from "@microflow/collab";
import { ReactFlowBridge } from "./react-flow-bridge";
import { formatRow, header, section, timeMedian } from "@microflow/collab/bench-report";

/** The merge as it was before identity preservation. */
function baselineMerge(yjsNodes: FlowNode[], currentLocal: FlowNode[]): FlowNode[] {
  const localMap = new Map(currentLocal.map((n) => [n.id, n]));
  return yjsNodes.map((yjsNode) => {
    const local = localMap.get(yjsNode.id);
    return { ...yjsNode, selected: local?.selected, dragging: local?.dragging };
  });
}

function seed(count: number): FlowDocument {
  const doc = FlowDocument.createEmpty();
  doc.doc.transact(() => {
    for (let i = 0; i < count; i++) {
      doc.addNode({
        id: `n${i}`,
        type: "Led",
        position: { x: i * 10, y: i * 5 },
        data: { pin: i % 14, label: `Node ${i}`, settings: { a: 1, b: 2, c: 3 } },
        width: 160,
        height: 80,
      });
    }
  }, "seed");
  return doc;
}

/** Identity changes produced by `edits` sequential single-node updates. */
function measure(
  nodeCount: number,
  edits: number,
  merge: (yjs: FlowNode[], local: FlowNode[]) => FlowNode[],
): { rerenders: number; ms: number } {
  const doc = seed(nodeCount);
  let snapshot = doc.getNodes();
  let rerenders = 0;

  const start = performance.now();
  for (let i = 0; i < edits; i++) {
    // A peer moves one node — the commonest remote event there is.
    doc.updateNodePosition(`n${i % nodeCount}`, { x: i, y: i });
    const merged = merge(doc.getNodes(), snapshot);
    for (let j = 0; j < merged.length; j++) {
      if (merged[j] !== snapshot[j]) rerenders++;
    }
    snapshot = merged;
  }
  const ms = performance.now() - start;

  doc.destroy();
  return { rerenders, ms };
}

header("ReactFlowBridge — snapshot merge");

section("Node re-renders caused by remote edits");
console.log(
  formatRow(["flow size", "edits", "before", "after", "reduction"], [12, 8, 14, 14, 12]),
);

for (const nodeCount of [25, 100, 300, 1000]) {
  const edits = 200;
  const before = measure(nodeCount, edits, baselineMerge);
  const after = measure(nodeCount, edits, ReactFlowBridge.mergeYjsIntoSnapshot);

  console.log(
    formatRow(
      [
        `${nodeCount} nodes`,
        String(edits),
        before.rerenders.toLocaleString(),
        after.rerenders.toLocaleString(),
        `${(before.rerenders / Math.max(after.rerenders, 1)).toFixed(0)}x fewer`,
      ],
      [12, 8, 14, 14, 12],
    ),
  );
}

section("Merge cost in isolation (1000 merges)");
console.log(
  "Doc mutation excluded — this is the merge call itself, which is where the\n" +
    "extra per-node comparison is paid. The win is not here; it is in the work\n" +
    "React no longer does downstream.\n",
);
console.log(formatRow(["flow size", "before", "after", "ratio"], [12, 14, 14, 12]));

for (const nodeCount of [25, 100, 300, 1000]) {
  const doc = seed(nodeCount);
  const yjsNodes = doc.getNodes();
  const snapshot = ReactFlowBridge.mergeYjsIntoSnapshot(yjsNodes, []);

  const run = (merge: (y: FlowNode[], l: FlowNode[]) => FlowNode[]) => () => {
    for (let i = 0; i < 1000; i++) merge(yjsNodes, snapshot);
  };

  // Warm up so neither side pays JIT costs the other avoids.
  run(baselineMerge)();
  run(ReactFlowBridge.mergeYjsIntoSnapshot)();

  const before = timeMedian(5, run(baselineMerge));
  const after = timeMedian(5, run(ReactFlowBridge.mergeYjsIntoSnapshot));

  console.log(
    formatRow(
      [
        `${nodeCount} nodes`,
        `${before.toFixed(1)}ms`,
        `${after.toFixed(1)}ms`,
        `${(before / after).toFixed(2)}x`,
      ],
      [12, 14, 14, 12],
    ),
  );
  doc.destroy();
}

section("Scaled to a room: re-renders per second");
console.log(
  "Assuming each active contributor commits ~2 edits/second to a 300-node flow.\n",
);
console.log(formatRow(["contributors", "before", "after"], [14, 20, 20]));

for (const contributors of [2, 5, 10, 20]) {
  const editsPerSecond = contributors * 2;
  const before = 300 * editsPerSecond;
  const after = 1 * editsPerSecond;
  console.log(
    formatRow(
      [
        String(contributors),
        `${before.toLocaleString()} renders/s`,
        `${after.toLocaleString()} renders/s`,
      ],
      [14, 20, 20],
    ),
  );
}
