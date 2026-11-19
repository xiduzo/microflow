// The CLI text adapter, driven through the interface `chat()` uses (`chatStream`
// and `structuredOutput`) against a scripted agent CLI — no Tauri, no process.
//
// `scriptedAgentCli` is the `AgentCliPort` these tests run on. It plays back
// what a process wrote, which flow tools it called over MCP and how it exited,
// one step per turn of the event loop, and it keeps the desktop host's session
// rules. So a test reads as: this is what the CLI did, this is what it was
// started with, and this is the stream the turn runner saw.

import { describe, expect, it, mock } from "bun:test";
import { EventType } from "@tanstack/ai";
import { FlowDocument } from "@microflow/collab";

import { cliAdapterFor } from "./cli-adapter";
import { scriptedAgentCli, type ScriptedAgentCli } from "./scripted-agent-cli";
import { runTurn, type TurnOptions, type TurnUpdate } from "./turn-runner";

type Chunk = { type: string; [field: string]: unknown };

/** The adapter as `chat()` holds it. */
type Adapter = {
  kind: string;
  name: string;
  model: string;
  chatStream(options: unknown): AsyncIterable<Chunk>;
  structuredOutput(options: unknown): Promise<{ data: unknown; rawText: string }>;
};

function adapterOn(host: ScriptedAgentCli, id = "claude", model = "sonnet"): Adapter {
  const adapter = cliAdapterFor(id, model, async () => host);
  if (!adapter) throw new Error(`${id} is not a CLI provider`);
  return adapter as unknown as Adapter;
}

/** A flow tool as `chat()` hands it to an adapter: the tool's own `execute`,
 *  with its input schema already converted to JSON Schema. */
function tool(name: string, run: (args: unknown) => unknown = () => "ok") {
  return {
    name,
    description: `the ${name} tool`,
    inputSchema: {
      type: "object",
      properties: { nodeId: { type: "string" } },
      required: ["nodeId"],
    },
    execute: run,
  };
}

const user = (content: unknown) => ({ role: "user", content });
const assistant = (content: unknown) => ({ role: "assistant", content });

async function collect(stream: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const types = (chunks: Chunk[]) => chunks.map((chunk) => chunk.type);

/** The assistant text a stream carried. */
const textOf = (chunks: Chunk[]) =>
  chunks
    .filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((chunk) => chunk.delta)
    .join("");

/** The answer one prose run comes to. */
async function answerOf(host: ScriptedAgentCli, id = "claude"): Promise<string> {
  return textOf(await collect(adapterOn(host, id).chatStream({ messages: [user("hi")] })));
}

/** A promise the test settles by hand, to hold the scripted process in place. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** The value that follows `flag` in an argument vector. */
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

const PROSE = [
  EventType.RUN_STARTED,
  EventType.TEXT_MESSAGE_START,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_END,
  EventType.RUN_FINISHED,
];

describe("cliAdapterFor", () => {
  it("is a text adapter named after its CLI", () => {
    const adapter = adapterOn(scriptedAgentCli([]), "opencode", "ollama/qwen3");

    expect([adapter.kind, adapter.name, adapter.model]).toEqual([
      "text",
      "opencode",
      "ollama/qwen3",
    ]);
  });

  it("builds nothing for an id that names no CLI", () => {
    expect(cliAdapterFor("bash", "m", async () => scriptedAgentCli([]))).toBeUndefined();
  });
});

describe("what the CLI is started with", () => {
  const SYSTEM = "You edit flows.";

  /** Run one prose turn and return the one process it started. */
  async function started(id: string, model: string, options: Record<string, unknown>) {
    const host = scriptedAgentCli([{ stdout: "ok" }]);
    await collect(adapterOn(host, id, model).chatStream(options));
    expect(host.runs).toHaveLength(1);
    return host.runs[0];
  }

  it("hands a system prompt to a CLI that has a flag for it, and the prompt to stdin", async () => {
    const run = await started("claude", "sonnet", {
      messages: [user("add an LED")],
      systemPrompts: [SYSTEM],
    });

    expect(run).toEqual({
      bin: "claude",
      args: ["-p", "--model", "sonnet", "--append-system-prompt", SYSTEM],
      stdin: "add an LED",
    });
  });

  it("folds the system prompt into the prompt for a CLI with no such flag", async () => {
    const run = await started("codex", "gpt-5", {
      messages: [user("add an LED")],
      systemPrompts: [SYSTEM],
    });

    expect(run).toEqual({
      bin: "codex",
      args: ["exec", "--skip-git-repo-check", "--color", "never", "--model", "gpt-5"],
      stdin: `${SYSTEM}\n\nadd an LED`,
    });
  });

  it("appends the prompt to argv, and leaves stdin empty, for a CLI that reads no stdin", async () => {
    const run = await started("copilot", "auto", {
      messages: [user("add an LED")],
      systemPrompts: [SYSTEM],
    });

    expect(run).toEqual({
      bin: "copilot",
      args: ["--no-color", "--allow-all-tools", "--model", "auto", "-p", `${SYSTEM}\n\nadd an LED`],
      stdin: "",
    });
  });

  it("joins every system prompt, whichever form it arrives in, and drops empty ones", async () => {
    const run = await started("pi", "", {
      messages: [user("hi")],
      systemPrompts: ["One.", { content: "Two." }, "", { content: "" }, {}],
    });

    expect(run.args).toEqual(["-p", "--append-system-prompt", "One.\n\nTwo."]);
  });

  it("passes no system prompt at all when the turn has none", async () => {
    const withFlag = await started("claude", "sonnet", { messages: [user("hi")] });
    const inlined = await started("gemini", "", { messages: [user("hi")] });

    expect(withFlag.args).toEqual(["-p", "--model", "sonnet"]);
    expect(inlined).toEqual({ bin: "gemini", args: ["-p", "", "-o", "text"], stdin: "hi" });
  });

  it("sends a single message as it is", async () => {
    const run = await started("claude", "sonnet", { messages: [user("add an LED")] });

    expect(run.stdin).toBe("add an LED");
  });

  it("replays a conversation as labelled turns", async () => {
    const run = await started("claude", "sonnet", {
      messages: [user("add an LED"), assistant("Which pin?"), user("13")],
    });

    expect(run.stdin).toBe("User: add an LED\n\nAssistant: Which pin?\n\nUser: 13");
  });

  it("reads the text out of multi-part content and skips the parts that have none", async () => {
    const run = await started("claude", "sonnet", {
      messages: [
        user([
          { type: "text", text: "what is " },
          { type: "image", source: "…" },
          { type: "text", text: "this?" },
        ]),
        assistant(null),
      ],
    });

    expect(run.stdin).toBe("User: what is this?\n\nAssistant: ");
  });
});

// ADR-0024: `mcpArgs` is the per-CLI gate. A CLI that has it is pointed at a
// session for one run; a CLI without it gets no session at all.
describe("publishing the flow tools", () => {
  it("points a CLI that takes an MCP server per run at this turn's session, and at nothing else", async () => {
    const host = scriptedAgentCli([{ stdout: "ok" }]);

    await collect(
      adapterOn(host).chatStream({
        messages: [user("add an LED")],
        tools: [tool("add_node"), tool("connect")],
      }),
    );

    const [session] = host.sessions;
    expect(session.tools.map((spec) => spec.name)).toEqual(["add_node", "connect"]);

    const { args } = host.runs[0];
    expect(args.slice(0, 3)).toEqual(["-p", "--model", "sonnet"]);
    // The relay the host answered with, under the server name its permission
    // flags are written against.
    expect(JSON.parse(after(args, "--mcp-config"))).toEqual({
      mcpServers: {
        microflow: {
          command: "/Applications/Microflow.app/Contents/MacOS/Microflow",
          args: ["--mcp", session.token],
        },
      },
    });
    // Our tools and nothing else: no built-in toolbox, no user or project
    // settings, none of the MCP servers the user configured for their own work.
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--restricted");
    expect(after(args, "--tools")).toBe("");
    expect(after(args, "--allowedTools")).toBe("mcp__microflow__add_node,mcp__microflow__connect");
  });

  it("opens no session for a CLI that cannot take one, and its tool calls reach nothing", async () => {
    const ran = mock(() => "ok");
    const host = scriptedAgentCli([
      { call: "add_node", arguments: { nodeId: "abc" } },
      { stdout: "I would add an LED." },
    ]);

    const chunks = await collect(
      adapterOn(host, "codex", "").chatStream({
        messages: [user("add an LED")],
        tools: [tool("add_node", ran)],
      }),
    );

    expect(host.sessions).toEqual([]);
    expect(host.runs[0].args).toEqual(["exec", "--skip-git-repo-check", "--color", "never"]);
    expect(ran).not.toHaveBeenCalled();
    expect(types(chunks)).toEqual(PROSE);
    expect(textOf(chunks)).toBe("I would add an LED.");
  });

  it("opens no session for a turn that has no tools", async () => {
    const host = scriptedAgentCli([{ stdout: "ok" }]);

    await collect(adapterOn(host).chatStream({ messages: [user("hi")], tools: [] }));

    expect(host.sessions).toEqual([]);
    expect(host.runs[0].args).toEqual(["-p", "--model", "sonnet"]);
  });

  it("runs a prose turn when the host has no MCP server listening", async () => {
    const host = scriptedAgentCli([{ stdout: "I would add an LED." }], { listening: false });

    const chunks = await collect(
      adapterOn(host).chatStream({ messages: [user("add an LED")], tools: [tool("add_node")] }),
    );

    expect(host.runs[0].args).toEqual(["-p", "--model", "sonnet"]);
    expect(textOf(chunks)).toBe("I would add an LED.");
  });

  it("closes the session when the run is over", async () => {
    const host = scriptedAgentCli([{ stdout: "ok" }]);

    await collect(
      adapterOn(host).chatStream({ messages: [user("hi")], tools: [tool("add_node")] }),
    );

    expect(host.sessions.map((session) => session.open)).toEqual([false]);
  });
});

describe("the stream", () => {
  it("reports a prose answer as one assistant message", async () => {
    const host = scriptedAgentCli([{ stdout: "Pin 13 drives the LED." }]);

    const chunks = await collect(
      adapterOn(host).chatStream({ messages: [user("hi")], runId: "run-1", threadId: "thread-1" }),
    );

    expect(types(chunks)).toEqual(PROSE);
    const [started, opened, content, closed, finished] = chunks;
    expect(started).toMatchObject({ runId: "run-1", threadId: "thread-1", model: "sonnet" });
    expect(opened).toMatchObject({ role: "assistant" });
    expect(content).toMatchObject({
      delta: "Pin 13 drives the LED.",
      content: "Pin 13 drives the LED.",
    });
    expect(new Set([opened.messageId, content.messageId, closed.messageId]).size).toBe(1);
    expect(finished).toMatchObject({
      runId: "run-1",
      threadId: "thread-1",
      finishReason: "stop",
    });
  });

  it("reports the tools a CLI calls while it is still running, before its answer", async () => {
    const hold = gate();
    const host = scriptedAgentCli([
      { call: "add_node", arguments: { nodeId: "led" } },
      { call: "connect", arguments: { nodeId: "led" } },
      { hold: hold.opened },
      { stdout: "Added an LED and wired it." },
    ]);
    const stream = adapterOn(host)
      .chatStream({
        messages: [user("add an LED")],
        tools: [tool("add_node"), tool("connect")],
      })
      [Symbol.asyncIterator]();

    // Read until both calls are reported. The process is held open, so these
    // can only have come out while it was running.
    const early: Chunk[] = [];
    while (early.filter((chunk) => chunk.type === EventType.TOOL_CALL_END).length < 2) {
      const step = await stream.next();
      if (step.done) throw new Error("the stream ended before both calls were reported");
      early.push(step.value);
    }
    expect(host.running).toBe(true);
    expect(types(early)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_END,
    ]);

    // Each call is a complete start/end pair under an id of its own.
    const [, firstStart, firstEnd, secondStart, secondEnd] = early;
    expect(firstStart).toMatchObject({ toolCallName: "add_node", toolName: "add_node" });
    expect(secondStart).toMatchObject({ toolCallName: "connect", toolName: "connect" });
    expect(firstEnd.toolCallId).toBe(firstStart.toolCallId);
    expect(secondEnd.toolCallId).toBe(secondStart.toolCallId);
    expect(secondStart.toolCallId).not.toBe(firstStart.toolCallId);

    hold.open();
    const rest: Chunk[] = [];
    for (let step = await stream.next(); !step.done; step = await stream.next()) {
      rest.push(step.value);
    }
    expect(types(rest)).toEqual(PROSE.slice(1));
    expect(textOf(rest)).toBe("Added an LED and wired it.");
  });

  it("reports a call the CLI makes as its last act before the answer", async () => {
    const host = scriptedAgentCli([
      { stdout: "Added an LED." },
      { call: "add_node", arguments: { nodeId: "led" } },
    ]);

    const chunks = await collect(
      adapterOn(host).chatStream({ messages: [user("add an LED")], tools: [tool("add_node")] }),
    );

    expect(types(chunks)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_END,
      ...PROSE.slice(1),
    ]);
  });

  it("misses no call when the reader is slower than the CLI", async () => {
    const names = ["get_flow", "add_node", "add_node", "connect", "get_diagnostics"];
    const host = scriptedAgentCli([
      ...names.map((name) => ({ call: name, arguments: { nodeId: "n" } })),
      { stdout: "Done." },
    ]);
    const stream = adapterOn(host).chatStream({
      messages: [user("build it")],
      tools: [...new Set(names)].map((name) => tool(name)),
    });

    const chunks: Chunk[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
      // Several calls, and the exit, land between two reads.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const reported = chunks
      .filter((chunk) => chunk.type === EventType.TOOL_CALL_START)
      .map((chunk) => chunk.toolCallName);
    expect(reported).toEqual(names);
    expect(types(chunks).slice(-4)).toEqual(PROSE.slice(1));
    expect(textOf(chunks)).toBe("Done.");
  });

  it("runs each tool the CLI calls, and tells the CLI what it came to", async () => {
    const host = scriptedAgentCli([
      { call: "add_node", arguments: { nodeId: "led" } },
      { call: "connect", arguments: { nodeId: "led" } },
      { stdout: "Done." },
    ]);

    await collect(
      adapterOn(host).chatStream({
        messages: [user("add an LED")],
        tools: [
          tool("add_node", (args) => ({ added: args })),
          tool("connect", () => {
            throw new Error("no such handle");
          }),
        ],
      }),
    );

    expect(host.toolResults).toEqual([
      { name: "add_node", result: { added: { nodeId: "led" } } },
      { name: "connect", error: "no such handle" },
    ]);
  });
});

// Stop ends the process and closes the session. `chat()` hands an adapter the
// turn's abort signal as `request.signal`, and the adapter hands it on to the
// run.
describe("when the turn is stopped", () => {
  /** Let the scripted process take every step it still can. */
  const settle = async () => {
    for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it("ends the process and closes the session at once", async () => {
    const controller = new AbortController();
    const hold = gate();
    const ran = mock(() => "ok");
    const host = scriptedAgentCli([
      { call: "add_node", arguments: { nodeId: "first" } },
      { hold: hold.opened },
      { call: "add_node", arguments: { nodeId: "second" } },
      { stdout: "Added two LEDs." },
    ]);
    const stream = adapterOn(host)
      .chatStream({
        messages: [user("add two LEDs")],
        tools: [tool("add_node", ran)],
        request: { signal: controller.signal },
      })
      [Symbol.asyncIterator]();

    // The first call lands and is reported; then the user presses stop.
    for (let step = await stream.next(); ; step = await stream.next()) {
      if (step.done) throw new Error("the stream ended before the first call was reported");
      if (step.value.type === EventType.TOOL_CALL_END) break;
    }
    controller.abort(new Error("stopped by the user"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Both at the stop, not whenever the process would have exited.
    expect(host.running).toBe(false);
    expect(host.sessions.map((session) => session.open)).toEqual([false]);

    // Nothing the process had left to do happens, and nothing it printed is read.
    hold.open();
    await settle();
    const rest: Chunk[] = [];
    for (let step = await stream.next(); !step.done; step = await stream.next()) {
      rest.push(step.value);
    }
    expect(ran).toHaveBeenCalledTimes(1);
    expect(host.toolResults).toHaveLength(1);
    expect(types(rest)).toEqual([EventType.RUN_ERROR]);
    expect(rest[0].message).toBe("stopped by the user");
  });

  it("ends a CLI that has no session, which is how the Llm node runs one", async () => {
    const controller = new AbortController();
    const hold = gate();
    const host = scriptedAgentCli([{ hold: hold.opened }, { stdout: "A late answer." }]);
    const stream = adapterOn(host, "codex", "")
      .chatStream({ messages: [user("hi")], request: { signal: controller.signal } })
      [Symbol.asyncIterator]();

    expect((await stream.next()).value).toMatchObject({ type: EventType.RUN_STARTED });
    const next = stream.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.running).toBe(true);

    controller.abort(new Error("stopped by the user"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.running).toBe(false);

    hold.open();
    await settle();
    const rest: Chunk[] = [(await next).value as Chunk];
    for (let step = await stream.next(); !step.done; step = await stream.next()) {
      rest.push(step.value);
    }
    expect(types(rest)).toEqual([EventType.RUN_ERROR]);
    expect(textOf(rest)).toBe("");
  });

  it("ends a CLI that is writing a structured answer, and rejects with the reason", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped by the user");
    const hold = gate();
    const host = scriptedAgentCli([{ hold: hold.opened }, { stdout: "{}" }]);

    const asked = adapterOn(host).structuredOutput({
      chatOptions: { messages: [user("which pin?")], request: { signal: controller.signal } },
      outputSchema: { type: "object" },
    });
    while (!host.running) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(reason);

    await expect(asked).rejects.toBe(reason);
    expect(host.running).toBe(false);
  });

  it("does not answer a tool call that was in flight when the process ended", async () => {
    const controller = new AbortController();
    const working = gate();
    const host = scriptedAgentCli([
      { call: "add_node", arguments: { nodeId: "first" } },
      { call: "add_node", arguments: { nodeId: "second" } },
      { stdout: "Added two LEDs." },
    ]);
    // A tool that is still working when the user presses stop.
    const slow = mock(async () => {
      controller.abort();
      await working.opened;
      return "ok";
    });

    const chunks = collect(
      adapterOn(host).chatStream({
        messages: [user("add two LEDs")],
        tools: [tool("add_node", slow)],
        request: { signal: controller.signal },
      }),
    );
    while (slow.mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    working.open();
    await settle();

    // The process is gone: it is told nothing, and it asks for nothing more.
    expect(types(await chunks)).toContain(EventType.RUN_ERROR);
    expect(host.running).toBe(false);
    expect(host.toolResults).toEqual([]);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("leaves a run that has already ended as it ended", async () => {
    const controller = new AbortController();
    const host = scriptedAgentCli([{ stdout: "Done." }]);

    const chunks = await collect(
      adapterOn(host).chatStream({
        messages: [user("hi")],
        request: { signal: controller.signal },
      }),
    );
    // A stop that lost the race with the process exiting.
    controller.abort();
    await settle();

    expect(types(chunks)).toEqual(PROSE);
    expect(textOf(chunks)).toBe("Done.");
  });

  it("ends its own run and no other", async () => {
    const first = new AbortController();
    const second = new AbortController();
    const hold = gate();
    const host = scriptedAgentCli((invocation) =>
      invocation.stdin === "second"
        ? [{ hold: hold.opened }, { stdout: "The second answer." }]
        : [{ stdout: "The first answer." }],
    );
    const adapter = adapterOn(host);

    expect(
      textOf(
        await collect(
          adapter.chatStream({ messages: [user("first")], request: { signal: first.signal } }),
        ),
      ),
    ).toBe("The first answer.");

    const later = collect(
      adapter.chatStream({ messages: [user("second")], request: { signal: second.signal } }),
    );
    while (!host.running) await new Promise((resolve) => setTimeout(resolve, 0));

    // The first turn's stop arrives late: its process is long gone, and the
    // one running now belongs to another turn.
    first.abort();
    await settle();
    expect(host.running).toBe(true);

    hold.open();
    expect(textOf(await later)).toBe("The second answer.");
  });
});

// A stopped turn starts no CLI, on any path: a run nobody is waiting for is
// paid for all the same.
describe("when the turn is stopped before it starts", () => {
  /** An already-aborted signal, as `chat()` hands it to an adapter. */
  function stopped(reason = new Error("stopped by the user")) {
    const controller = new AbortController();
    controller.abort(reason);
    return { request: { signal: controller.signal }, reason };
  }
  const STOPPED = [EventType.RUN_STARTED, EventType.RUN_ERROR];

  it("starts no CLI and opens no session, for a CLI that takes the flow tools", async () => {
    const { request } = stopped();
    const host = scriptedAgentCli([{ stdout: "A run nobody asked for." }]);

    const chunks = await collect(
      adapterOn(host).chatStream({
        messages: [user("add an LED")],
        tools: [tool("add_node")],
        request,
      }),
    );

    expect(host.runs).toEqual([]);
    expect(host.sessions).toEqual([]);
    expect(types(chunks)).toEqual(STOPPED);
    expect(chunks[1].message).toBe("stopped by the user");
  });

  it("starts no CLI for one that cannot take the flow tools", async () => {
    const { request } = stopped();
    const host = scriptedAgentCli([{ stdout: "A run nobody asked for." }]);

    const chunks = await collect(
      adapterOn(host, "codex", "").chatStream({
        messages: [user("add an LED")],
        tools: [tool("add_node")],
        request,
      }),
    );

    expect(host.runs).toEqual([]);
    expect(types(chunks)).toEqual(STOPPED);
    expect(chunks[1].message).toBe("stopped by the user");
  });

  it("starts no CLI for a turn that has no tools, which is how the Llm node runs one", async () => {
    const { request } = stopped();
    const host = scriptedAgentCli([{ stdout: "A run nobody asked for." }]);

    const chunks = await collect(
      adapterOn(host).chatStream({ messages: [user("describe pin 13")], request }),
    );

    expect(host.runs).toEqual([]);
    expect(types(chunks)).toEqual(STOPPED);
    expect(chunks[1].message).toBe("stopped by the user");
  });

  it("starts no CLI for a structured answer, and rejects with the reason it was stopped", async () => {
    const { request, reason } = stopped();
    const host = scriptedAgentCli([{ stdout: "{}" }]);

    const asked = adapterOn(host).structuredOutput({
      chatOptions: { messages: [user("which pin?")], request },
      outputSchema: { type: "object" },
    });

    await expect(asked).rejects.toBe(reason);
    expect(host.runs).toEqual([]);
  });

  it("starts no CLI when the stop lands while its session is opening", async () => {
    const controller = new AbortController();
    const host = scriptedAgentCli([{ stdout: "A run nobody asked for." }]);
    const adapter = cliAdapterFor("claude", "sonnet", async () => ({
      ...host,
      openSession: async (session) => {
        const relay = await host.openSession(session);
        controller.abort();
        return relay;
      },
    })) as unknown as Adapter;

    const chunks = await collect(
      adapter.chatStream({
        messages: [user("add an LED")],
        tools: [tool("add_node")],
        request: { signal: controller.signal },
      }),
    );

    expect(host.runs).toEqual([]);
    expect(host.sessions.map((session) => session.open)).toEqual([false]);
    expect(types(chunks)).toEqual(STOPPED);
  });
});

// The whole webview side of ADR-0024 in one piece: the real turn runner, the
// real `chat()`, the real flow tools on a real `FlowDocument`, and Claude Code
// played back by the scripted host. What `chat()` hands an adapter (its tools,
// its abort signal) is whatever `chat()` really hands it.
describe("an Ask AI turn on a CLI that takes the flow tools", () => {
  function turnOn(host: ScriptedAgentCli, overrides: Partial<TurnOptions> = {}): TurnOptions {
    return {
      doc: new FlowDocument(),
      adapter: async () => {
        const adapter = cliAdapterFor("claude", "sonnet", async () => host);
        if (!adapter) throw new Error("claude is not a CLI provider");
        return adapter;
      },
      writeMode: "auto",
      history: [],
      prompt: "add an LED on pin 13",
      selectedNodeIds: [],
      controller: new AbortController(),
      ...overrides,
    };
  }

  it("edits the flow once per call, and shows the tool before the answer", async () => {
    const host = scriptedAgentCli([
      { call: "add_node", arguments: { type: "Led", data: { pin: 13 } } },
      { stdout: "Added an LED on pin 13." },
    ]);
    const options = turnOn(host);

    const updates: TurnUpdate[] = [];
    for await (const update of runTurn(options)) updates.push(update);

    // `chat()` saw a tool call go by. It must not run it a second time: the
    // CLI already did, over MCP.
    expect(options.doc.getNodes()).toHaveLength(1);
    expect(host.toolResults).toHaveLength(1);
    expect("result" in host.toolResults[0]).toBe(true);
    expect(updates).toEqual([
      { tools: ["add_node"] },
      { content: "Added an LED on pin 13." },
      { content: "Added an LED on pin 13.", tools: ["add_node"] },
    ]);
  });

  it("shows the CLI every flow tool with the tool's own input schema", async () => {
    const host = scriptedAgentCli([{ stdout: "Nothing to do." }]);

    for await (const _ of runTurn(turnOn(host))) void _;

    const published = host.sessions[0].tools;
    expect(published.map((spec) => spec.name)).toContain("add_node");
    for (const spec of published) {
      expect(spec.description.length).toBeGreaterThan(0);
      expect(spec.inputSchema.type).toBe("object");
    }
    // Without its fields a model has to guess what `add_node` takes.
    const addNode = published.find((spec) => spec.name === "add_node");
    expect(Object.keys(addNode?.inputSchema.properties as object)).toEqual(["type", "data"]);
    expect(addNode?.inputSchema.required).toContain("type");
  });

  it("can publish, and so can check, the tools of every write mode", async () => {
    for (const writeMode of ["auto", "confirm", "read-only"] as const) {
      const host = scriptedAgentCli([{ stdout: "Nothing to do." }]);

      const updates: TurnUpdate[] = [];
      for await (const update of runTurn(turnOn(host, { writeMode }))) updates.push(update);

      expect(updates.filter((update) => update.error)).toEqual([]);
      expect(host.sessions[0].tools.length).toBeGreaterThan(0);
    }
  });

  it("publishes no write tool in read-only mode, so the CLI cannot change the flow", async () => {
    const host = scriptedAgentCli([
      { call: "add_node", arguments: { type: "Led", data: { pin: 13 } } },
      { stdout: "I can only look." },
    ]);
    const options = turnOn(host, { writeMode: "read-only" });

    for await (const _ of runTurn(options)) void _;

    expect(host.sessions[0].tools.map((spec) => spec.name)).not.toContain("add_node");
    const [told] = host.toolResults;
    expect("error" in told && told.error).toContain("no tool 'add_node'");
    expect(options.doc.getNodes()).toHaveLength(0);
  });

  // The schema the CLI was shown is the gate its calls go through: a call that
  // does not fit it is answered by the bridge, in words a model can act on, and
  // never reaches the tool.
  for (const [name, missing] of [
    ["connect", ["source", "sourceHandle", "target", "targetHandle"]],
    ["delete_node", ["nodeId"]],
    ["update_node_data", ["nodeId", "data"]],
    ["delete_edge", ["edgeId"]],
    ["add_node", ["type"]],
  ] as const) {
    it(`tells the model which fields a bare ${name} call is missing, and changes nothing`, async () => {
      const host = scriptedAgentCli([
        { call: "add_node", arguments: { type: "Led", data: { pin: 13 } } },
        { call: name, arguments: {} },
        { stdout: "Hm." },
      ]);
      const options = turnOn(host);

      for await (const _ of runTurn(options)) void _;

      expect(host.toolResults[1]).toEqual({
        name,
        error: `invalid arguments for ${name}: ${missing.map((field) => `${field} is required`).join("; ")}`,
      });
      expect(options.doc.getNodes()).toHaveLength(1);
      expect(options.doc.getEdges()).toHaveLength(0);
    });
  }

  it("tells the model what a field of the wrong type should have been", async () => {
    const host = scriptedAgentCli([
      { call: "add_node", arguments: { type: 5 } },
      { call: "add_node", arguments: { type: "Led", data: 13 } },
      { call: "connect", arguments: { source: "a", sourceHandle: "out", target: 7 } },
      { stdout: "Hm." },
    ]);
    const options = turnOn(host);

    for await (const _ of runTurn(options)) void _;

    expect(host.toolResults).toEqual([
      {
        name: "add_node",
        error: "invalid arguments for add_node: type: expected string, received number",
      },
      {
        name: "add_node",
        error: "invalid arguments for add_node: data: expected object or string, received number",
      },
      {
        name: "connect",
        error:
          "invalid arguments for connect: target: expected string, received number; targetHandle is required",
      },
    ]);
    expect(options.doc.getNodes()).toHaveLength(0);
  });

  it("lets through every shape of call the published schemas allow", async () => {
    const host = scriptedAgentCli([
      { call: "get_flow" },
      { call: "add_node", arguments: { type: "Led" } },
      { call: "add_node", arguments: { type: "Led", data: { pin: 13, nested: { deep: [1] } } } },
      // Models send `data` as a JSON string often enough that the tools take it.
      { call: "add_node", arguments: { type: "Button", data: '{"pin": 2}' } },
      // A field the schema does not name is not the gate's to refuse.
      { call: "add_node", arguments: { type: "Led", comment: "the red one" } },
      { stdout: "Done." },
    ]);
    const options = turnOn(host);

    for await (const _ of runTurn(options)) void _;

    for (const told of host.toolResults) {
      expect("error" in told ? told.error : undefined).toBeUndefined();
    }
    expect(options.doc.getNodes()).toHaveLength(4);
  });

  it("ends the CLI the moment the user stops the turn, and shows no error for it", async () => {
    const hold = gate();
    const host = scriptedAgentCli([
      { call: "add_node", arguments: { type: "Led", data: { pin: 13 } } },
      { hold: hold.opened },
      { call: "add_node", arguments: { type: "Button", data: { pin: 2 } } },
      { stdout: "Added an LED and a button." },
    ]);
    const options = turnOn(host);
    const turn = runTurn(options);

    // The first tool shows in the panel; the user presses stop.
    expect((await turn.next()).value).toEqual({ tools: ["add_node"] });
    options.controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.running).toBe(false);
    expect(host.sessions.map((session) => session.open)).toEqual([false]);

    // The turn ends silently: nothing staged, and no update that says it failed.
    expect(await turn.next()).toEqual({ done: true, value: [] });

    // What the process had left to do never happens.
    hold.open();
    for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(options.doc.getNodes()).toHaveLength(1);
    expect(host.toolResults).toHaveLength(1);
  });

  it("keeps a turn that finished as it finished when a stop arrives after it", async () => {
    const host = scriptedAgentCli([
      { call: "add_node", arguments: { type: "Led", data: { pin: 13 } } },
      { stdout: "Added an LED on pin 13." },
    ]);
    const options = turnOn(host);

    const updates: TurnUpdate[] = [];
    for await (const update of runTurn(options)) updates.push(update);
    // The panel closes, or the user was a moment late.
    options.controller.abort();
    for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updates.at(-1)).toEqual({ content: "Added an LED on pin 13.", tools: ["add_node"] });
    expect(updates.filter((update) => update.error)).toEqual([]);
    expect(options.doc.getNodes()).toHaveLength(1);
  });

  it("does not let one turn's stop end the next turn's CLI", async () => {
    const hold = gate();
    const host = scriptedAgentCli((invocation) =>
      invocation.stdin.includes("second")
        ? [
            { hold: hold.opened },
            { call: "add_node", arguments: { type: "Button", data: { pin: 2 } } },
            { stdout: "Added a button." },
          ]
        : [{ stdout: "Nothing to do." }],
    );
    const doc = new FlowDocument();
    const first = turnOn(host, { doc, prompt: "first" });
    for await (const _ of runTurn(first)) void _;

    const second = turnOn(host, { doc, prompt: "second" });
    const updates: TurnUpdate[] = [];
    const running = (async () => {
      for await (const update of runTurn(second)) updates.push(update);
    })();
    while (!host.running) await new Promise((resolve) => setTimeout(resolve, 0));

    // The first turn is abandoned late, while the second one's CLI is running.
    first.controller.abort();
    for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.running).toBe(true);
    expect(host.sessions.map((session) => session.open)).toEqual([false, true]);

    hold.open();
    await running;
    expect(updates.at(-1)).toEqual({ content: "Added a button.", tools: ["add_node"] });
    expect(doc.getNodes()).toHaveLength(1);
  });
});

describe("when the CLI fails", () => {
  const FAILED = [EventType.RUN_STARTED, EventType.RUN_ERROR];

  it("ends the run with what the CLI wrote to stderr", async () => {
    const host = scriptedAgentCli([
      { stdout: "half an ans" },
      { stderr: "Invalid API key · Please run /login\n" },
      { exit: 1 },
    ]);

    const chunks = await collect(adapterOn(host).chatStream({ messages: [user("hi")] }));

    expect(types(chunks)).toEqual(FAILED);
    expect(chunks[1]).toMatchObject({
      message: "claude: Invalid API key · Please run /login",
      code: "cli_error",
      error: { message: "claude: Invalid API key · Please run /login", code: "cli_error" },
    });
  });

  it("names the exit status when the CLI said nothing", async () => {
    const host = scriptedAgentCli([{ exit: 2 }]);

    const chunks = await collect(adapterOn(host).chatStream({ messages: [user("hi")] }));

    expect(types(chunks)).toEqual(FAILED);
    expect(chunks[1].message).toBe("claude exited with exit status: 2");
  });

  it("still reports the tools it called before it failed, and closes the session", async () => {
    const host = scriptedAgentCli([
      { call: "add_node", arguments: { nodeId: "led" } },
      { stderr: "rate limited" },
      { exit: 1 },
    ]);

    const chunks = await collect(
      adapterOn(host).chatStream({ messages: [user("add an LED")], tools: [tool("add_node")] }),
    );

    expect(types(chunks)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_END,
      EventType.RUN_ERROR,
    ]);
    expect(chunks.at(-1)?.message).toBe("claude: rate limited");
    expect(host.sessions.map((session) => session.open)).toEqual([false]);
  });

  it("ends the run with the reason when the host cannot be reached at all", async () => {
    const adapter = cliAdapterFor("claude", "sonnet", async () => {
      throw new Error("Not running on desktop");
    }) as unknown as Adapter;

    const chunks = await collect(adapter.chatStream({ messages: [user("hi")] }));

    expect(types(chunks)).toEqual(FAILED);
    expect(chunks[1].message).toBe("Not running on desktop");
  });
});

describe("what stdout becomes", () => {
  it("strips terminal colour codes, wherever the process happened to flush", async () => {
    // The escape sequence is split across two writes. The host collects stdout
    // whole, so the split cannot leave half a sequence in the answer.
    const host = scriptedAgentCli([
      { stdout: "\u001B[1" },
      { stdout: "mPin 13\u001B[0m drives the \u001B[38;5;196mLED\u001B[0m.\n" },
      { stdout: "\u001B[?25h\n" },
    ]);

    expect(await answerOf(host)).toBe("Pin 13 drives the LED.");
  });

  it("drops the session header opencode prints, coloured or not", async () => {
    const host = scriptedAgentCli([
      { stdout: "\u001B[0m\n\u001B[90m> build · qwen3-coder:latest\u001B[0m\n\n" },
      { stdout: "OK\n" },
    ]);

    expect(await answerOf(host, "opencode")).toBe("OK");
  });

  it("keeps a line that looks like a header for a CLI that prints none", async () => {
    const host = scriptedAgentCli([{ stdout: "> quoted\nand answered\n" }]);

    expect(await answerOf(host)).toBe("> quoted\nand answered");
  });

  it("keeps what the CLI wrote to stderr out of an answer that succeeded", async () => {
    const host = scriptedAgentCli([{ stderr: "⠋ thinking…" }, { stdout: "OK" }]);

    expect(await answerOf(host)).toBe("OK");
  });
});

describe("structuredOutput", () => {
  const SCHEMA = { type: "object", properties: { pin: { type: "number" } } };
  const ask = (host: ScriptedAgentCli, id = "claude", chatOptions: Record<string, unknown> = {}) =>
    adapterOn(host, id).structuredOutput({
      chatOptions: { messages: [user("which pin?")], ...chatOptions },
      outputSchema: SCHEMA,
    });

  it("parses a bare JSON answer", async () => {
    const host = scriptedAgentCli([{ stdout: '{"pin": 13}\n' }]);

    expect(await ask(host)).toEqual({ data: { pin: 13 }, rawText: '{"pin": 13}' });
  });

  it("parses JSON the CLI wrapped in a fence, with or without a language", async () => {
    const tagged = scriptedAgentCli([
      { stdout: 'Here you go:\n```json\n{"pin": 13}\n```\nAnything else?' },
    ]);
    const bare = scriptedAgentCli([{ stdout: '```\n{"pin": 2}\n```' }]);

    expect((await ask(tagged)).data).toEqual({ pin: 13 });
    expect((await ask(bare)).data).toEqual({ pin: 2 });
    expect((await ask(tagged)).rawText).toBe(
      'Here you go:\n```json\n{"pin": 13}\n```\nAnything else?',
    );
  });

  it("parses a fenced answer through the colour codes around it", async () => {
    const host = scriptedAgentCli([{ stdout: '\u001B[2m```json\u001B[0m\n{"pin": 13}\n```' }]);

    expect((await ask(host)).data).toEqual({ pin: 13 });
  });

  it("says which CLI did not return JSON, and what it said instead", async () => {
    const host = scriptedAgentCli([{ stdout: "Pin 13, I think." }]);

    await expect(ask(host)).rejects.toThrow("claude did not return JSON: Pin 13, I think.");
  });

  it("fails with the CLI's own error when the run fails", async () => {
    const host = scriptedAgentCli([{ stderr: "not logged in" }, { exit: 1 }]);

    await expect(ask(host)).rejects.toThrow("claude: not logged in");
  });

  it("asks for the schema after the turn's own system prompts", async () => {
    const instruction = `Reply with JSON matching this schema and nothing else: ${JSON.stringify(SCHEMA)}`;
    const withFlag = scriptedAgentCli([{ stdout: "{}" }]);
    const inlined = scriptedAgentCli([{ stdout: "{}" }]);

    await ask(withFlag, "claude", { systemPrompts: ["Be terse."] });
    await ask(inlined, "codex", { systemPrompts: ["Be terse."] });

    expect(after(withFlag.runs[0].args, "--append-system-prompt")).toBe(
      `Be terse.\n\n${instruction}`,
    );
    expect(withFlag.runs[0].stdin).toBe("which pin?");
    expect(inlined.runs[0].stdin).toBe(`Be terse.\n\n${instruction}\n\nwhich pin?`);
  });

  it("publishes no tools, so a structured answer has no side effects", async () => {
    const ran = mock(() => "ok");
    const host = scriptedAgentCli([
      { call: "add_node", arguments: { nodeId: "led" } },
      { stdout: "{}" },
    ]);

    await ask(host, "claude", { tools: [tool("add_node", ran)] });

    expect(host.sessions).toEqual([]);
    expect(host.runs[0].args).not.toContain("--mcp-config");
    expect(ran).not.toHaveBeenCalled();
  });
});
