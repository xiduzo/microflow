/**
 * What does one accepted edit cost on the way to the runtime?
 *
 * `FlowUpdateDispatcher` observes every doc change — local edits and remote
 * sync arrivals alike — and each accepted dispatch builds a full `FlowUpdate`
 * and computes `runtimeRelevantKey`, which sorts and JSON-stringifies the
 * whole flow. That work used to happen twice per successful dispatch.
 *
 * Run: bun bench/dispatch-key.bench.ts (from apps/web)
 */

import { FlowDocument, type FlowNode } from "@microflow/collab";
import {
  buildFlowUpdate,
  runtimeRelevantKey,
  type HostSnapshot,
  type NodeAdapterRegistry,
} from "../src/session/flow-update-dispatcher";
import { formatRow, header, section, timeMedian } from "./report";

const EMPTY_REGISTRY: NodeAdapterRegistry = {};
const snapshot = (): HostSnapshot => ({
  brokers: [],
  providers: [],
  figma: { uniqueId: null },
});

/** A flow with realistic `data` payloads — function source, prompts, patterns. */
function seed(nodeCount: number): FlowDocument {
  const doc = FlowDocument.createEmpty();
  doc.doc.transact(() => {
    for (let i = 0; i < nodeCount; i++) {
      const node: FlowNode = {
        id: `n${i}`,
        type: i % 5 === 0 ? "Function" : "Led",
        position: { x: i * 10, y: i * 5 },
        data:
          i % 5 === 0
            ? {
                instance: "Function",
                code: `// node ${i}\nfunction run(input) {\n  return input * ${i} + Math.sin(input);\n}`,
                label: `Function ${i}`,
              }
            : { instance: "Led", pin: i % 14, label: `LED ${i}` },
        width: 160,
        height: 80,
      };
      doc.nodes.set(node.id, node);
      if (i > 0) {
        doc.edges.set(`e${i}`, {
          id: `e${i}`,
          source: `n${i - 1}`,
          target: `n${i}`,
          sourceHandle: "value",
          targetHandle: "value",
        });
      }
    }
  }, "seed");
  return doc;
}

header("FlowUpdateDispatcher — per-dispatch cost");

section("Building the update and keying it (1000 dispatches)");
console.log(
  "'before' computes runtimeRelevantKey twice per dispatch, as the previous\n" +
    "code did on every successful send; 'after' computes it once.\n",
);
console.log(
  formatRow(["flow size", "payload", "before", "after", "saved"], [12, 12, 12, 12, 10]),
);

for (const nodeCount of [25, 100, 300, 1000]) {
  const doc = seed(nodeCount);
  const payloadBytes = JSON.stringify(buildFlowUpdate(doc, snapshot(), EMPTY_REGISTRY)).length;

  const before = () => {
    for (let i = 0; i < 1000; i++) {
      const update = buildFlowUpdate(doc, snapshot(), EMPTY_REGISTRY);
      runtimeRelevantKey(update);
      runtimeRelevantKey(update);
    }
  };
  const after = () => {
    for (let i = 0; i < 1000; i++) {
      const update = buildFlowUpdate(doc, snapshot(), EMPTY_REGISTRY);
      runtimeRelevantKey(update);
    }
  };

  before();
  after();
  const beforeMs = timeMedian(3, before);
  const afterMs = timeMedian(3, after);

  console.log(
    formatRow(
      [
        `${nodeCount} nodes`,
        `${(payloadBytes / 1024).toFixed(0)} KB`,
        `${beforeMs.toFixed(0)}ms`,
        `${afterMs.toFixed(0)}ms`,
        `${(100 - (afterMs / beforeMs) * 100).toFixed(0)}%`,
      ],
      [12, 12, 12, 12, 10],
    ),
  );
  doc.destroy();
}

section("Per-dispatch, and what a busy room costs");
console.log(
  "Each accepted change from any contributor triggers one dispatch on every\n" +
    "desktop client in the room. Times are for a single dispatch.\n",
);
console.log(
  formatRow(["flow size", "before", "after", "at 10 dispatch/s (after)"], [12, 12, 12, 26]),
);

for (const nodeCount of [25, 100, 300, 1000]) {
  const doc = seed(nodeCount);

  const once = (double: boolean) => () => {
    for (let i = 0; i < 200; i++) {
      const update = buildFlowUpdate(doc, snapshot(), EMPTY_REGISTRY);
      runtimeRelevantKey(update);
      if (double) runtimeRelevantKey(update);
    }
  };

  once(true)();
  once(false)();
  const beforeMs = timeMedian(3, once(true)) / 200;
  const afterMs = timeMedian(3, once(false)) / 200;

  console.log(
    formatRow(
      [
        `${nodeCount} nodes`,
        `${beforeMs.toFixed(2)}ms`,
        `${afterMs.toFixed(2)}ms`,
        `${(afterMs * 10).toFixed(1)}ms/s of main thread`,
      ],
      [12, 12, 12, 26],
    ),
  );
  doc.destroy();
}

section("IPC payload sent to the Tauri runtime per dispatch");
console.log(
  "The whole flow crosses the IPC boundary on every dispatch, even when one\n" +
    "node's `data` changed. Core already diffs per node on the far side; this is\n" +
    "the cost of getting there. (Item 13 in the audit — not yet addressed.)\n",
);
console.log(formatRow(["flow size", "payload", "at 10 dispatch/s"], [12, 14, 20]));

for (const nodeCount of [25, 100, 300, 1000]) {
  const doc = seed(nodeCount);
  const bytes = JSON.stringify(buildFlowUpdate(doc, snapshot(), EMPTY_REGISTRY)).length;
  console.log(
    formatRow(
      [
        `${nodeCount} nodes`,
        `${(bytes / 1024).toFixed(0)} KB`,
        `${((bytes * 10) / 1024 / 1024).toFixed(2)} MB/s`,
      ],
      [12, 14, 20],
    ),
  );
  doc.destroy();
}
