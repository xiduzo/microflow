import { describe, expect, test } from "bun:test";
import type { Edge, Node } from "@xyflow/react";
import {
  buildGenerateSketchCommand,
  buildSketchDownloadRequest,
  canDownloadSketch,
  createDebouncedRegenerator,
  GENERATING_SKETCH_PLACEHOLDER,
  hasFlowChanged,
  projectSketchResult,
  serializeFlowGraph,
  type RegeneratorTimers,
  type SketchInvoker,
  type SketchViewState,
} from "../sketch-code-view.model";

const NODE: Node = {
  id: "led-1",
  type: "Led",
  position: { x: 0, y: 0 },
  data: { pin: 13 },
};

describe("buildGenerateSketchCommand", () => {
  test("wraps the current Flow graph in a generate_sketch command", () => {
    const nodes: Node[] = [NODE];
    const edges: Edge[] = [{ id: "e1", source: "a", target: "b" }];

    const command = buildGenerateSketchCommand(nodes, edges);

    expect(command).toEqual({
      type: "generate_sketch",
      flow: { nodes, edges },
    });
  });

  test("supports an empty Flow", () => {
    expect(buildGenerateSketchCommand([], [])).toEqual({
      type: "generate_sketch",
      flow: { nodes: [], edges: [] },
    });
  });
});

describe("projectSketchResult", () => {
  // Scenario: Opening the Code view shows the sketch read-only
  test("on success the editor value is the generated sketch text", async () => {
    const invoker: SketchInvoker = async () => ({
      success: true,
      data: "void setup() {}\nvoid loop() {}",
    });

    const state = await projectSketchResult(invoker, [NODE], []);

    expect(state).toEqual({
      value: "void setup() {}\nvoid loop() {}",
      isError: false,
    });
  });

  // Scenario: The shown sketch can be copied — the full text is preserved verbatim
  test("the full sketch text is preserved verbatim for copying", async () => {
    const sketch = [
      "// microflow generated sketch",
      "void setup() {",
      "  pinMode(13, OUTPUT);",
      "}",
      "void loop() {}",
    ].join("\n");
    const invoker: SketchInvoker = async () => ({ success: true, data: sketch });

    const state = await projectSketchResult(invoker, [NODE], []);

    expect(state.value).toBe(sketch);
  });

  // Scenario: An empty Flow shows a valid empty sketch (no error)
  test("an empty Flow yields the generator's empty sketch with no error", async () => {
    const emptySketch = "void setup() {}\nvoid loop() {}";
    let received: { nodes: unknown[]; edges: unknown[] } | undefined;
    const invoker: SketchInvoker = async (command) => {
      received = command.flow;
      return { success: true, data: emptySketch };
    };

    const state = await projectSketchResult(invoker, [], []);

    expect(received).toEqual({ nodes: [], edges: [] });
    expect(state).toEqual({ value: emptySketch, isError: false });
  });

  // Edge case: generation error surfaces as text, panel does not crash
  test("on failure the error string is surfaced as the editor value", async () => {
    const invoker: SketchInvoker = async () => ({
      success: false,
      error: "boom",
    });

    const state = await projectSketchResult(invoker, [NODE], []);

    expect(state.isError).toBe(true);
    expect(state.value).toContain("boom");
  });

  // Edge case: a missing data field still resolves to a stable empty value
  test("a success response without data resolves to an empty string", async () => {
    const invoker: SketchInvoker = async () => ({ success: true });

    const state = await projectSketchResult(invoker, [], []);

    expect(state).toEqual({ value: "", isError: false });
  });
});

describe("serializeFlowGraph / hasFlowChanged", () => {
  test("identical graphs serialize equally and are reported unchanged", () => {
    const a = serializeFlowGraph([NODE], []);
    const b = serializeFlowGraph([NODE], []);

    expect(a).toBe(b);
    expect(hasFlowChanged(b, a)).toBe(false);
  });

  test("adding a node changes the serialization", () => {
    const before = serializeFlowGraph([NODE], []);
    const after = serializeFlowGraph([NODE, { ...NODE, id: "led-2" }], []);

    expect(hasFlowChanged(after, before)).toBe(true);
  });

  test("an undefined baseline is always treated as changed", () => {
    expect(hasFlowChanged(serializeFlowGraph([], []), undefined)).toBe(true);
  });
});

/**
 * Manual fake-clock harness: scheduled callbacks fire only when `tick` advances
 * past their due time. Lets us assert debounce/coalesce behavior deterministically.
 */
function makeFakeTimers() {
  let now = 0;
  let nextId = 1;
  const scheduled = new Map<number, { due: number; handler: () => void }>();

  const timers: RegeneratorTimers = {
    setTimeout: (handler, ms) => {
      const id = nextId++;
      scheduled.set(id, { due: now + ms, handler });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      scheduled.delete(handle as unknown as number);
    },
  };

  function tick(ms: number) {
    now += ms;
    const due = Array.from(scheduled.entries()).filter(([, entry]) => entry.due <= now);
    for (const [id, entry] of due) {
      scheduled.delete(id);
      entry.handler();
    }
  }

  return { timers, tick };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const LED2: Node = { id: "led-2", type: "Led", position: { x: 1, y: 1 }, data: { pin: 12 } };

describe("createDebouncedRegenerator", () => {
  // Scenario: Editing the Flow updates the displayed sketch
  test("a graph change triggers regeneration after the debounce window", async () => {
    const { timers, tick } = makeFakeTimers();
    const results: SketchViewState[] = [];
    const invoker: SketchInvoker = async () => ({ success: true, data: "sketch-v1" });

    const regen = createDebouncedRegenerator({
      invoker,
      onResult: (s) => results.push(s),
      debounceMs: 400,
      timers,
    });

    regen.schedule([NODE], []);
    expect(results).toHaveLength(0); // nothing before the window elapses
    tick(400);
    await flush();

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ value: "sketch-v1", isError: false });
  });

  // Scenario: Rapid edits collapse into a single regeneration
  test("rapid successive edits collapse into one regeneration with the latest graph", async () => {
    const { timers, tick } = makeFakeTimers();
    const seen: Array<{ nodes: number }> = [];
    const invoker: SketchInvoker = async (command) => {
      seen.push({ nodes: command.flow.nodes.length });
      return { success: true, data: `nodes:${command.flow.nodes.length}` };
    };
    const results: SketchViewState[] = [];

    const regen = createDebouncedRegenerator({
      invoker,
      onResult: (s) => results.push(s),
      debounceMs: 400,
      timers,
    });

    // Several edits in quick succession (each within the debounce window).
    regen.schedule([NODE], []);
    tick(100);
    regen.schedule([NODE, LED2], []);
    tick(100);
    regen.schedule([NODE, LED2, { ...LED2, id: "led-3" }], []);

    // Author pauses.
    tick(400);
    await flush();

    expect(seen).toHaveLength(1); // coalesced into a single generation
    expect(seen[0]).toEqual({ nodes: 3 }); // reflects the latest Flow
    expect(results[results.length - 1]?.value).toBe("nodes:3");
  });

  // Scenario: Adding a Node updates the sketch
  test("adding a node regenerates including the new node's graph", async () => {
    const { timers, tick } = makeFakeTimers();
    const flows: Node[][] = [];
    const invoker: SketchInvoker = async (command) => {
      flows.push(command.flow.nodes as Node[]);
      return { success: true, data: "ok" };
    };

    const regen = createDebouncedRegenerator({
      invoker,
      onResult: () => {},
      debounceMs: 400,
      timers,
      seedSerialized: serializeFlowGraph([NODE], []),
    });

    regen.schedule([NODE, LED2], []);
    tick(400);
    await flush();

    expect(flows).toHaveLength(1);
    expect(flows[0]?.map((n) => n.id)).toEqual(["led-1", "led-2"]);
  });

  test("an unchanged graph is not regenerated (skips redundant generation)", async () => {
    const { timers, tick } = makeFakeTimers();
    let calls = 0;
    const invoker: SketchInvoker = async () => {
      calls++;
      return { success: true, data: "x" };
    };

    const regen = createDebouncedRegenerator({
      invoker,
      onResult: () => {},
      debounceMs: 400,
      timers,
      seedSerialized: serializeFlowGraph([NODE], []),
    });

    regen.schedule([NODE], []); // identical to the seed
    tick(400);
    await flush();

    expect(calls).toBe(0);
  });

  test("cancel prevents a pending regeneration from firing", async () => {
    const { timers, tick } = makeFakeTimers();
    let calls = 0;
    const invoker: SketchInvoker = async () => {
      calls++;
      return { success: true, data: "x" };
    };

    const regen = createDebouncedRegenerator({
      invoker,
      onResult: () => {},
      debounceMs: 400,
      timers,
    });

    regen.schedule([NODE], []);
    regen.cancel();
    tick(400);
    await flush();

    expect(calls).toBe(0);
  });

  test("a stale in-flight response is dropped; only the latest result is applied", async () => {
    const { timers, tick } = makeFakeTimers();
    const results: SketchViewState[] = [];
    // First response resolves slowly, second quickly — latest must win.
    const resolvers: Array<(s: string) => void> = [];
    const invoker: SketchInvoker = () =>
      new Promise((resolve) =>
        resolvers.push((value) => resolve({ success: true, data: value })),
      ) as ReturnType<SketchInvoker>;

    const regen = createDebouncedRegenerator({
      invoker,
      onResult: (s) => results.push(s),
      debounceMs: 400,
      timers,
    });

    regen.schedule([NODE], []);
    tick(400); // fires request #1
    regen.schedule([NODE, LED2], []);
    tick(400); // fires request #2

    // Resolve request #2 (latest) first, then the stale #1.
    resolvers[1]?.("latest");
    resolvers[0]?.("stale");
    await flush();

    expect(results.map((r) => r.value)).toEqual(["latest"]);
  });
});

describe("canDownloadSketch", () => {
  // Scenario: Download control is available on the Code view
  test("a generated sketch enables download", () => {
    const state: SketchViewState = {
      value: "void setup() {}\nvoid loop() {}",
      isError: false,
    };

    expect(canDownloadSketch(state)).toBe(true);
  });

  // Scenario: Download control available for a Flow with unsupported Nodes
  test("a sketch with unsupported-Node placeholder comments still enables download", () => {
    const state: SketchViewState = {
      value: ["// microflow generated sketch", "// Unsupported node: Mqtt", "void loop() {}"].join(
        "\n",
      ),
      isError: false,
    };

    expect(canDownloadSketch(state)).toBe(true);
  });

  // Scenario: Download control available for an unnamed Flow
  test("an unnamed Flow (empty-stub sketch) still enables download", () => {
    const state: SketchViewState = { value: "void setup() {}\nvoid loop() {}", isError: false };

    // The view state carries no Flow name; download stays enabled regardless.
    expect(canDownloadSketch(state)).toBe(true);
  });

  test("the generating placeholder disables download until a sketch exists", () => {
    const state: SketchViewState = { value: GENERATING_SKETCH_PLACEHOLDER, isError: false };

    expect(canDownloadSketch(state)).toBe(false);
  });

  test("an empty value disables download (nothing to hand off yet)", () => {
    expect(canDownloadSketch({ value: "", isError: false })).toBe(false);
  });

  test("a generation error disables download", () => {
    const state: SketchViewState = {
      value: "// Failed to generate sketch:\n// boom",
      isError: true,
    };

    expect(canDownloadSketch(state)).toBe(false);
  });
});

describe("buildSketchDownloadRequest", () => {
  // Scenario: Activating Download starts the hand-off
  test("wraps the displayed sketch in a SketchDownloaded intent", () => {
    const sketch = "void setup() {}\nvoid loop() {}";

    expect(buildSketchDownloadRequest(sketch)).toEqual({
      type: "SketchDownloaded",
      sketch,
      suggestedFilename: "sketch.ino",
    });
  });

  // Scenario: the suggested filename is carried through to the write step
  test("carries a provided suggested filename", () => {
    const sketch = "void setup() {}\nvoid loop() {}";

    expect(buildSketchDownloadRequest(sketch, "blinker.ino")).toEqual({
      type: "SketchDownloaded",
      sketch,
      suggestedFilename: "blinker.ino",
    });
  });

  // Invariant: the string handed off is byte-for-byte what the view displays
  test("preserves the sketch string byte-for-byte", () => {
    const sketch = [
      "// microflow generated sketch",
      "void setup() {",
      "  pinMode(13, OUTPUT);",
      "}",
      "void loop() {}",
      "", // trailing newline preserved
    ].join("\n");

    expect(buildSketchDownloadRequest(sketch).sketch).toBe(sketch);
  });

  // Edge case: placeholder-comment sketch is handed off verbatim
  test("hands off an unsupported-Node placeholder sketch verbatim", () => {
    const sketch = "// Unsupported node: Mqtt\nvoid loop() {}";

    expect(buildSketchDownloadRequest(sketch).sketch).toBe(sketch);
  });
});
