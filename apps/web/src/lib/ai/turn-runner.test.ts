// The Ask AI turn loop, driven against a fake adapter — no live model.
//
// The adapter is the ADR-0021 seam, so a fake implementing `chatStream` is all
// it takes to exercise the real `chat()` agent loop: tool execution against a
// real `FlowDocument`, the iteration cap, abort, and what `confirm` mode
// stages. The regression pinned here: pending changes must accumulate across
// turns — `setPending(staged)` used to replace them, so a second confirm-mode
// turn silently discarded the first turn's unapproved changes.

import { describe, expect, test } from "bun:test";
import { EventType } from "@tanstack/ai";
import type { AnyTextAdapter } from "@tanstack/ai";
import { FlowDocument } from "@microflow/collab";

// `NODE_REGISTRY` pulls in every node component, and some of them read the web
// env at import time. Seed it before the dynamic import below — under `bun test`
// there is no Vite to supply it.
process.env.VITE_SERVER_URL ??= "http://localhost:3000";
const { MAX_ITERATIONS, NO_PROVIDER_MESSAGE, mergePending, runTurn } = await import(
  "./turn-runner"
);
const { applyChanges } = await import("./flow-tools");
type TurnUpdate = import("./turn-runner").TurnUpdate;
type TurnOptions = import("./turn-runner").TurnOptions;
type PendingChange = import("./flow-tools").PendingChange;

type Chunk = Record<string, unknown>;
type ChatOptions = { messages: ReadonlyArray<{ role: string; content: unknown }> };

let nextToolCall = 0;

/** The chunks one model turn that only answers in text produces. */
function textRun(...deltas: string[]): Chunk[] {
  const at = Date.now();
  return [
    { type: EventType.RUN_STARTED, runId: "run", threadId: "thread", timestamp: at },
    { type: EventType.TEXT_MESSAGE_START, messageId: "msg", role: "assistant", timestamp: at },
    ...deltas.map((delta) => ({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg",
      delta,
      timestamp: at,
    })),
    { type: EventType.TEXT_MESSAGE_END, messageId: "msg", timestamp: at },
    {
      type: EventType.RUN_FINISHED,
      runId: "run",
      threadId: "thread",
      finishReason: "stop",
      timestamp: at,
    },
  ];
}

/** The chunks one model turn that calls a single tool produces. */
function toolRun(name: string, args: Record<string, unknown>): Chunk[] {
  const at = Date.now();
  const toolCallId = `tc-${nextToolCall++}`;
  return [
    { type: EventType.RUN_STARTED, runId: "run", threadId: "thread", timestamp: at },
    { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: name, timestamp: at },
    { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(args), timestamp: at },
    { type: EventType.TOOL_CALL_END, toolCallId, timestamp: at },
    {
      type: EventType.RUN_FINISHED,
      runId: "run",
      threadId: "thread",
      finishReason: "tool_calls",
      timestamp: at,
    },
  ];
}

/** A text adapter whose Nth model turn yields `script(options, N)`. Implements
 *  the same interface `cli-adapter.ts` does: `chat()` only reads `kind`,
 *  `name`, `model`, `chatStream` and `structuredOutput`. */
function fakeAdapter(script: (options: ChatOptions, invocation: number) => Chunk[]) {
  const received: ChatOptions[] = [];
  const adapter = {
    kind: "text" as const,
    name: "fake",
    model: "fake-model",
    async *chatStream(options: unknown): AsyncIterable<Chunk> {
      const chatOptions = options as ChatOptions;
      const invocation = received.length;
      received.push(chatOptions);
      yield* script(chatOptions, invocation);
    },
    structuredOutput: async () => ({ data: null, rawText: "" }),
  };
  return { adapter: adapter as unknown as AnyTextAdapter, received };
}

/** Run one turn to completion, collecting its updates and its staged changes. */
async function drain(options: TurnOptions) {
  const turn = runTurn(options);
  const updates: TurnUpdate[] = [];
  let step = await turn.next();
  while (!step.done) {
    updates.push(step.value);
    step = await turn.next();
  }
  return { updates, staged: step.value };
}

function options(overrides: Partial<TurnOptions>): TurnOptions {
  return {
    doc: new FlowDocument(),
    adapter: undefined,
    writeMode: "auto",
    history: [],
    prompt: "do the thing",
    selectedNodeIds: [],
    controller: new AbortController(),
    ...overrides,
  };
}

describe("runTurn — confirm mode staging", () => {
  test("REGRESSION: two confirm-mode turns accumulate staged changes", async () => {
    const doc = new FlowDocument();
    const turnFor = (type: string, pin: number) =>
      fakeAdapter((_, invocation) =>
        invocation === 0 ? toolRun("add_node", { type, data: { pin } }) : textRun("Done."),
      );

    const first = await drain(
      options({ doc, writeMode: "confirm", adapter: async () => turnFor("Led", 13).adapter }),
    );
    const second = await drain(
      options({ doc, writeMode: "confirm", adapter: async () => turnFor("Button", 2).adapter }),
    );

    expect(first.staged).toHaveLength(1);
    expect(second.staged).toHaveLength(1);
    // Nothing reached the document while the user had not answered.
    expect(doc.getNodes()).toHaveLength(0);

    // The hook's merge: append, never replace. Replacing was the bug — the
    // second turn's staging silently discarded the first turn's changes.
    let pending: PendingChange[] = [];
    pending = mergePending(pending, first.staged);
    pending = mergePending(pending, second.staged);
    expect(pending).toHaveLength(2);
    expect(pending.map((c) => c.summary).join(" ")).toMatch(/Led[\s\S]*Button/);

    applyChanges(doc, pending);
    expect(doc.getNodes()).toHaveLength(2);
  });
});

describe("runTurn — the loop", () => {
  test("abort mid-stream leaves a consistent transcript", async () => {
    const controller = new AbortController();
    const { adapter } = fakeAdapter(() => textRun("Hel", "lo there"));

    const turn = runTurn(options({ adapter: async () => adapter, controller }));
    const updates: TurnUpdate[] = [];
    let step = await turn.next();
    while (!step.done) {
      updates.push(step.value);
      // Abort as soon as the first delta lands, mid-stream.
      controller.abort();
      step = await turn.next();
    }

    // The partial text stands; no error notice, no final patch, nothing staged.
    expect(updates).toEqual([{ content: "Hel" }]);
    expect(step.value).toEqual([]);
  });

  test("MAX_ITERATIONS stops a tool-calling loop", async () => {
    const { adapter, received } = fakeAdapter(() => toolRun("get_flow", {}));

    const { updates } = await drain(options({ adapter: async () => adapter }));

    // A model that never stops calling tools gets exactly the budget, then the
    // turn ends instead of looping against the user's endpoint forever.
    expect(received).toHaveLength(MAX_ITERATIONS);
    const last = updates.at(-1);
    expect(last?.error).toBeUndefined();
    expect(last?.tools).toHaveLength(MAX_ITERATIONS);
  });

  test("no provider yields the error notice and stages nothing", async () => {
    const { updates, staged } = await drain(options({ adapter: undefined }));

    expect(updates).toEqual([{ content: NO_PROVIDER_MESSAGE, error: true }]);
    expect(staged).toEqual([]);
  });

  test("error messages are filtered from the history sent to the adapter", async () => {
    const { adapter, received } = fakeAdapter(() => textRun("ok"));

    await drain(
      options({
        adapter: async () => adapter,
        history: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          // Our own failure notice and an unfinished streaming placeholder:
          // UI state, not something the model said.
          { role: "assistant", content: "our failure notice", error: true },
          { role: "assistant", content: "" },
        ],
        prompt: "next question",
      }),
    );

    const wire = JSON.stringify(received[0].messages);
    expect(wire).toContain("hello");
    expect(wire).toContain("next question");
    expect(wire).not.toContain("our failure notice");
  });
});
