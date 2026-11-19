// The Flow Tool Server's webview half, driven by a scripted agent CLI.
//
// `scriptedAgentCli` is the `AgentCliPort` these tests run on: it plays back a
// process that calls flow tools over MCP, and keeps the host's session rules
// (token, roster, budget, close). Every test opens a session through
// `withFlowToolServer`, starts the process the way the CLI adapter does, and
// asserts on what the process was told and on what ran.

import { describe, expect, it, mock } from "bun:test";
import { z } from "zod";

import type { AgentCliPort, RelayCommand } from "./agent-cli-port";
import { CALL_BUDGET, withFlowToolServer } from "./mcp-bridge";
import { scriptedAgentCli, type ScriptedAgentCli } from "./scripted-agent-cli";

const NODE_ID = {
  type: "object",
  properties: { nodeId: { type: "string" } },
  required: ["nodeId"],
};

/** A tool as `chat()` hands it to an adapter, which is how every tool reaches
 *  the bridge: the tool's own `execute`, and its input schema already converted
 *  to JSON Schema. */
function tool(name: string, run: (args: unknown) => unknown, inputSchema: unknown = NODE_ID) {
  return { name, description: `the ${name} tool`, inputSchema, execute: run } as never;
}

/** Start the scripted process pointed at the session, as a CLI would be. */
const spawn = (host: ScriptedAgentCli) => (relay: RelayCommand | undefined) =>
  host.run({ bin: "claude", args: relay ? ["--mcp-config", ...relay.args] : [], stdin: "" });

/** A process that was never given the session's relay command. */
const spawnWithoutRelay = (host: ScriptedAgentCli) => () =>
  host.run({ bin: "claude", args: ["-p"], stdin: "" });

/** A promise the test settles by hand, to hold the scripted process in place. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe("withFlowToolServer", () => {
  it("publishes the JSON Schema each tool arrives with", async () => {
    const inputSchema = {
      type: "object",
      properties: { type: { type: "string", description: "Component type" } },
      required: ["type"],
    };
    const host = scriptedAgentCli([]);

    await withFlowToolServer(
      host,
      { tools: [tool("add_node", () => "ok", inputSchema)] },
      spawn(host),
    );

    expect(host.sessions[0].tools).toEqual([
      { name: "add_node", description: "the add_node tool", inputSchema },
    ]);
  });

  it("publishes a tool that has no input as taking an empty object", async () => {
    const bare = { name: "get_flow", description: "Read the flow", execute: () => "ok" } as never;
    const host = scriptedAgentCli([]);

    await withFlowToolServer(host, { tools: [bare] }, spawn(host));

    expect(host.sessions[0].tools[0].inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("runs the tool the CLI called and answers with its result", async () => {
    const host = scriptedAgentCli([{ call: "add_node", arguments: { nodeId: "abc" } }]);

    await withFlowToolServer(
      host,
      { tools: [tool("add_node", (args) => ({ got: args }))] },
      spawn(host),
    );

    expect(host.toolResults).toEqual([{ name: "add_node", result: { got: { nodeId: "abc" } } }]);
  });

  it("reports each call as it arrives, while the CLI is still running", async () => {
    const hold = gate();
    const host = scriptedAgentCli([
      { call: "add_node", arguments: { nodeId: "abc" } },
      { hold: hold.opened },
    ]);
    const seen: Array<{ name: string; running: boolean }> = [];

    await withFlowToolServer(
      host,
      {
        tools: [tool("add_node", () => "ok")],
        onCall: (name) => {
          seen.push({ name, running: host.running });
          hold.open();
        },
      },
      spawn(host),
    );

    expect(seen).toEqual([{ name: "add_node", running: true }]);
  });

  it("reports a thrown tool as a tool error, never as a failed turn", async () => {
    const boom = tool("add_node", () => {
      throw new Error("the pin is taken");
    });
    const host = scriptedAgentCli([
      { call: "add_node", arguments: { nodeId: "abc" } },
      { stdout: "I will try another pin." },
    ]);

    // The whole point: the CLI reads this and tries something else.
    const stdout = await withFlowToolServer(host, { tools: [boom] }, spawn(host));

    expect(host.toolResults).toEqual([{ name: "add_node", error: "the pin is taken" }]);
    expect(stdout).toBe("I will try another pin.");
  });

  it("hands the tool the arguments as the CLI sent them, fields the schema does not name included", async () => {
    const host = scriptedAgentCli([{ call: "add_node", arguments: { nodeId: "abc", note: 1 } }]);
    const got: unknown[] = [];

    await withFlowToolServer(host, { tools: [tool("add_node", (args) => got.push(args))] }, spawn(host));

    expect(got).toEqual([{ nodeId: "abc", note: 1 }]);
  });

  it("publishes exactly the turn's tools, so the host refuses any other name", async () => {
    // The roster the bridge hands the host is the whole grant: a tool that is
    // not in it never reaches the webview, and the CLI is told what is.
    const host = scriptedAgentCli([{ call: "delete_everything" }]);
    const seen: string[] = [];

    await withFlowToolServer(
      host,
      {
        tools: [tool("add_node", () => "ok"), tool("connect", () => "ok")],
        onCall: (name) => seen.push(name),
      },
      spawn(host),
    );

    expect(host.sessions[0].tools.map((spec) => spec.name)).toEqual(["add_node", "connect"]);
    expect(seen).toEqual([]);
    expect(host.toolResults).toEqual([
      {
        name: "delete_everything",
        error: "no tool 'delete_everything' — this turn exposes: add_node, connect",
      },
    ]);
  });

  it("falls back to a prose turn when nothing is listening", async () => {
    const host = scriptedAgentCli([{ stdout: "prose" }], { listening: false });
    const given: Array<RelayCommand | undefined> = [];

    await withFlowToolServer(host, { tools: [tool("add_node", () => "ok")] }, (relay) => {
      given.push(relay);
      return spawn(host)(relay);
    });

    // `undefined` is the signal to run the CLI without an MCP server rather
    // than an error — the platform simply has no transport.
    expect(given).toEqual([undefined]);
    expect(host.sessions).toEqual([]);
  });
});

// ADR-0024: what the CLI is shown is what its call is validated against. One
// test per JSON Schema construct the flow tools' schemas use, plus the ones a
// tool is likely to grow into, so a zod upgrade that changes what
// `z.fromJSONSchema` makes of one of them fails here.
describe("withFlowToolServer — the published schema is the gate", () => {
  /** Call a tool that takes `inputSchema` with `args`: whether it ran, and the
   *  error the CLI was told, if any. */
  async function calling(inputSchema: unknown, args?: unknown) {
    const ran = mock(() => "ran");
    const host = scriptedAgentCli([{ call: "edit", arguments: args }]);
    await withFlowToolServer(host, { tools: [tool("edit", ran, inputSchema)] }, spawn(host));
    const [told] = host.toolResults;
    return { ran: ran.mock.calls.length > 0, error: "error" in told ? told.error : undefined };
  }
  const refused = (reason: string) => ({
    ran: false,
    error: `invalid arguments for edit: ${reason}`,
  });
  const RAN = { ran: true, error: undefined };

  /** `data` as `add_node` and `update_node_data` publish it. */
  const DATA = {
    anyOf: [
      { type: "object", propertyNames: { type: "string" }, additionalProperties: {} },
      { type: "string" },
    ],
  };
  const object = (properties: Record<string, unknown>, rest: Record<string, unknown> = {}) => ({
    type: "object",
    properties,
    ...rest,
  });

  it("required: names every field that is missing, and runs nothing", async () => {
    const schema = object(
      { source: { type: "string" }, target: { type: "string" }, note: { type: "string" } },
      { required: ["source", "target"] },
    );

    expect(await calling(schema, {})).toEqual(refused("source is required; target is required"));
    expect(await calling(schema, { source: "a" })).toEqual(refused("target is required"));
    // An optional field may be left out.
    expect(await calling(schema, { source: "a", target: "b" })).toEqual(RAN);
  });

  it("type: says what each field should have been and what it was", async () => {
    const schema = object({
      s: { type: "string" },
      n: { type: "number" },
      i: { type: "integer" },
      b: { type: "boolean" },
      a: { type: "array", items: { type: "number" } },
      o: { type: "object" },
    });

    expect(await calling(schema, { s: 1, n: "1", i: 1.5, b: "yes", a: [1, "2"], o: [] })).toEqual(
      refused(
        [
          "s: expected string, received number",
          "n: expected number, received string",
          "i: expected integer, received number",
          "b: expected boolean, received string",
          "a.1: expected number, received string",
          "o: expected object, received array",
        ].join("; "),
      ),
    );
    expect(await calling(schema, { s: "x", n: 1.5, i: 2, b: false, a: [1, 2], o: {} })).toEqual(RAN);
    expect(await calling(schema, { s: null })).toEqual(
      refused("s: expected string, received null"),
    );
  });

  it("type: the arguments themselves must be an object", async () => {
    expect(await calling(NODE_ID, ["abc"])).toEqual(refused("expected object, received array"));
    expect(await calling(NODE_ID, "abc")).toEqual(refused("expected object, received string"));
  });

  it("takes a call with no arguments, or null ones, as a call with none", async () => {
    const takesNothing = { type: "object", properties: {}, required: [] };

    expect(await calling(takesNothing)).toEqual(RAN);
    expect(await calling(takesNothing, null)).toEqual(RAN);
    expect(await calling(NODE_ID, null)).toEqual(refused("nodeId is required"));
  });

  it("anyOf: accepts any branch, and names them all when none fits", async () => {
    const schema = object({ data: DATA }, { required: ["data"] });

    expect(await calling(schema, { data: { pin: 13 } })).toEqual(RAN);
    expect(await calling(schema, { data: '{"pin": 13}' })).toEqual(RAN);
    expect(await calling(schema, { data: 13 })).toEqual(
      refused("data: expected object or string, received number"),
    );
    expect(await calling(schema, { data: [13] })).toEqual(
      refused("data: expected object or string, received array"),
    );
    expect(await calling(schema, { data: null })).toEqual(
      refused("data: expected object or string, received null"),
    );
    expect(await calling(schema, {})).toEqual(refused("data is required"));
  });

  it("anyOf: a branch that fails deeper in is not reported as a wrong type", async () => {
    const schema = object({
      at: { anyOf: [object({ x: { type: "number" } }, { required: ["x"] }), { type: "string" }] },
    });

    const told = await calling(schema, { at: { x: "left" } });

    expect(told.ran).toBe(false);
    expect(told.error).toBe("invalid arguments for edit: at: Invalid input");
  });

  it("propertyNames and additionalProperties: an open object takes any fields", async () => {
    const schema = object({ data: DATA });

    expect(await calling(schema, { data: {} })).toEqual(RAN);
    expect(
      await calling(schema, { data: { pin: 13, label: "x", nested: { deep: [1, null] } } }),
    ).toEqual(RAN);
  });

  it("additionalProperties: holds extra fields to the schema it gives", async () => {
    const schema = object({ pins: { type: "object", additionalProperties: { type: "number" } } });

    expect(await calling(schema, { pins: { red: 13, green: 12 } })).toEqual(RAN);
    expect(await calling(schema, { pins: { red: "13" } })).toEqual(
      refused("pins.red: expected number, received string"),
    );
  });

  it("additionalProperties: refuses unnamed fields only where the schema says false", async () => {
    const open = object({ nodeId: { type: "string" } });
    const closed = object({ nodeId: { type: "string" } }, { additionalProperties: false });

    expect(await calling(open, { nodeId: "a", note: 1 })).toEqual(RAN);
    expect(await calling(closed, { nodeId: "a", note: 1 })).toEqual(
      refused('Unrecognized key: "note"'),
    );
  });

  it("propertyNames: holds field names to the schema it gives", async () => {
    const schema = object({
      pins: {
        type: "object",
        propertyNames: { type: "string", pattern: "^[a-z]+$" },
        additionalProperties: {},
      },
    });

    expect(await calling(schema, { pins: { red: 13 } })).toEqual(RAN);
    expect(await calling(schema, { pins: { "Not OK": 13 } })).toEqual(
      refused("pins.Not OK: Invalid key in record"),
    );
  });

  it("KNOWN LIMIT: three shapes `chat()` never derives are published but not enforced", async () => {
    // `z.fromJSONSchema` (zod 4.3) drops these without complaint. A schema
    // derived from zod always states `type`, lists `properties` and types its
    // `propertyNames`, so no flow tool has them; this pins the limit so the
    // note on `publish` cannot go stale unnoticed.
    const untypedNames = object({
      pins: { type: "object", propertyNames: { pattern: "^[a-z]+$" }, additionalProperties: {} },
    });
    const requiredWithoutProperties = { type: "object", required: ["nodeId"] };
    const noType = { properties: { nodeId: { type: "string" } }, required: ["nodeId"] };

    expect(await calling(untypedNames, { pins: { "Not OK": 13 } })).toEqual(RAN);
    expect(await calling(requiredWithoutProperties, {})).toEqual(RAN);
    expect(await calling(noType, {})).toEqual(RAN);
  });

  it("enum: names the values that would have been accepted", async () => {
    const schema = object({ mode: { enum: ["auto", "confirm"] } }, { required: ["mode"] });

    expect(await calling(schema, { mode: "confirm" })).toEqual(RAN);
    expect(await calling(schema, { mode: "yolo" })).toEqual(
      refused('mode: Invalid option: expected one of "auto"|"confirm"'),
    );
    expect(await calling(schema, {})).toEqual(refused("mode is required"));
  });

  it("refuses to publish a tool whose schema it cannot check, and opens nothing", async () => {
    // A tool the CLI could call unchecked is not published quietly.
    const host = scriptedAgentCli([]);
    const publishing = (inputSchema: unknown) =>
      withFlowToolServer(host, { tools: [tool("edit", () => "ok", inputSchema)] }, spawn(host));

    await expect(publishing(object({ a: { not: { type: "string" } } }))).rejects.toThrow(
      "cannot publish the tool 'edit'",
    );
    await expect(
      publishing(JSON.parse('{ "if": { "type": "string" }, "then": { "minLength": 3 } }')),
    ).rejects.toThrow("cannot publish the tool 'edit'");
    // A zod schema is not JSON Schema: `chat()` converts it before the adapter
    // sees the tool, and a tool that skipped that has nothing to show the CLI.
    await expect(publishing(z.object({ nodeId: z.string() }))).rejects.toThrow(
      "cannot publish the tool 'edit': its input schema is not JSON Schema",
    );

    expect(host.sessions).toEqual([]);
    expect(host.runs).toEqual([]);
  });
});

// ADR-0024: the session's lifetime is the security boundary. These pin what a
// process can and cannot reach, and for how long.
describe("withFlowToolServer — the session is the grant", () => {
  it("opens the session with the call budget, and nothing runs once it is spent", async () => {
    const ran = mock(() => "ok");
    const host = scriptedAgentCli(
      Array.from({ length: CALL_BUDGET + 1 }, () => ({
        call: "add_node",
        arguments: { nodeId: "abc" },
      })),
    );

    await withFlowToolServer(host, { tools: [tool("add_node", ran)] }, spawn(host));

    expect(ran).toHaveBeenCalledTimes(CALL_BUDGET);
    const last = host.toolResults.at(-1);
    expect(last && "error" in last && last.error).toContain("every tool call allowed");
  });

  it("gives every session a token of its own", async () => {
    const host = scriptedAgentCli([]);

    await withFlowToolServer(host, { tools: [tool("add_node", () => "ok")] }, spawn(host));
    await withFlowToolServer(host, { tools: [tool("add_node", () => "ok")] }, spawn(host));

    const [first, second] = host.sessions.map((session) => session.token);
    expect(first.length).toBeGreaterThan(0);
    expect(second).not.toBe(first);
  });

  it("keeps a process that was not handed the relay away from the tools", async () => {
    // The token is the authorisation: every process this user runs can reach
    // the socket, and only the one spawned with the token can use it.
    const ran = mock(() => "ok");
    const host = scriptedAgentCli([{ call: "add_node", arguments: { nodeId: "abc" } }]);

    await withFlowToolServer(host, { tools: [tool("add_node", ran)] }, spawnWithoutRelay(host));

    expect(ran).not.toHaveBeenCalled();
    const [told] = host.toolResults;
    expect("error" in told && told.error).toContain("no Ask AI turn open");
  });

  it("closes the session even when the run throws", async () => {
    // An aborted turn must not leave the tools published — the session's
    // lifetime is the security boundary, not the happy path.
    const host = scriptedAgentCli([{ stderr: "not logged in" }, { exit: 1 }]);

    await expect(
      withFlowToolServer(host, { tools: [tool("add_node", () => "ok")] }, spawn(host)),
    ).rejects.toThrow("claude: not logged in");

    expect(host.sessions.map((session) => session.open)).toEqual([false]);
    expect(host.subscribers).toBe(0);
  });

  it("closes the session when it cannot subscribe to tool calls, and starts no CLI", async () => {
    // The session is open on the host before the webview listens for its
    // calls. A subscription that fails must not leave it open: its token could
    // still be used, and nothing here would ever close it.
    const ran = mock(() => "ok");
    const host = scriptedAgentCli([{ call: "add_node", arguments: { nodeId: "abc" } }]);
    const subscribe = host.onToolCall;
    host.onToolCall = async () => {
      throw new Error("the event bridge is gone");
    };

    await expect(
      withFlowToolServer(host, { tools: [tool("add_node", ran)] }, spawn(host)),
    ).rejects.toThrow("the event bridge is gone");

    expect(host.sessions.map((session) => session.open)).toEqual([false]);
    expect(host.runs).toEqual([]);

    // The next turn has the tools to itself.
    host.onToolCall = subscribe;
    await withFlowToolServer(host, { tools: [tool("add_node", ran)] }, spawn(host));
    expect(ran).toHaveBeenCalledTimes(1);
    expect(host.sessions.map((session) => session.open)).toEqual([false, false]);
    expect(host.subscribers).toBe(0);
  });

  it("stops listening for tool calls when the run is over", async () => {
    // One subscriber left behind per turn would hear every later turn's calls.
    const host = scriptedAgentCli([{ call: "add_node", arguments: { nodeId: "abc" } }]);
    let during = 0;

    await withFlowToolServer(host, { tools: [tool("add_node", () => "ok")] }, (relay) => {
      during = host.subscribers;
      return spawn(host)(relay);
    });

    expect(during).toBe(1);
    expect(host.subscribers).toBe(0);
  });

  it("leaves nothing a later process can reach with the old token", async () => {
    const ran = mock(() => "ok");
    const host = scriptedAgentCli((invocation) =>
      invocation.stdin === "late" ? [{ call: "add_node", arguments: { nodeId: "abc" } }] : [],
    );
    let relay: RelayCommand | undefined;

    await withFlowToolServer(host, { tools: [tool("add_node", ran)] }, async (given) => {
      relay = given;
    });
    await host.run({ bin: "claude", args: relay?.args ?? [], stdin: "late" });

    expect(ran).not.toHaveBeenCalled();
    const [told] = host.toolResults;
    expect("error" in told && told.error).toContain("no Ask AI turn open");
  });

  it("lets only the newest session act, so a write cannot land twice", async () => {
    // The host broadcasts every call to every subscriber. The outer turn is
    // still subscribed while the inner one runs, and both hold `add_node`:
    // without the guard one call would add two nodes.
    const ran = mock(() => "ok");
    const host = scriptedAgentCli([{ call: "add_node", arguments: { nodeId: "abc" } }]);

    await withFlowToolServer(host, { tools: [tool("add_node", ran)] }, () =>
      withFlowToolServer(host, { tools: [tool("add_node", ran)] }, spawn(host)),
    );

    expect(ran).toHaveBeenCalledTimes(1);
    expect(host.toolResults).toEqual([{ name: "add_node", result: "ok" }]);
  });

  it("closes the session the moment the turn is aborted", async () => {
    // Stopping a turn also ends its process, but a process takes a moment to
    // end. This one is not ended at all, which is the worst that moment can be:
    // with the session closed, whatever it does next cannot reach the flow.
    const controller = new AbortController();
    const hold = gate();
    const ran = mock(() => "ok");
    const host = scriptedAgentCli([
      { hold: hold.opened },
      { call: "add_node", arguments: { nodeId: "abc" } },
    ]);

    await withFlowToolServer(
      host,
      { tools: [tool("add_node", ran)], signal: controller.signal },
      async (relay) => {
        const exited = spawn(host)(relay);
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 0));
        // Closed while the process is still going, not when it exits.
        expect(host.running).toBe(true);
        expect(host.sessions.map((session) => session.open)).toEqual([false]);
        expect(host.subscribers).toBe(0);
        hold.open();
        await exited;
      },
    );

    expect(ran).not.toHaveBeenCalled();
    const [told] = host.toolResults;
    expect("error" in told && told.error).toContain("no Ask AI turn open");
  });

  it("starts nothing for a turn that is already stopped: no session, no CLI", async () => {
    // Running the CLI is a paid run the user already stopped.
    const controller = new AbortController();
    controller.abort();
    const host = scriptedAgentCli([{ call: "add_node", arguments: { nodeId: "abc" } }]);

    await expect(
      withFlowToolServer(
        host,
        { tools: [tool("add_node", () => "ok")], signal: controller.signal },
        spawn(host),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(host.sessions).toEqual([]);
    expect(host.runs).toEqual([]);
  });

  it("starts no CLI when the stop lands while the session is opening", async () => {
    // The abort fires before the bridge is listening for it. It must still
    // count: the session is closed again and the CLI is never started.
    const controller = new AbortController();
    const host = scriptedAgentCli([{ call: "add_node", arguments: { nodeId: "abc" } }]);
    const stoppedWhileOpening: AgentCliPort = {
      ...host,
      openSession: async (session) => {
        const relay = await host.openSession(session);
        controller.abort();
        return relay;
      },
    };

    await expect(
      withFlowToolServer(
        stoppedWhileOpening,
        { tools: [tool("add_node", () => "ok")], signal: controller.signal },
        spawn(host),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(host.sessions.map((session) => session.open)).toEqual([false]);
    expect(host.subscribers).toBe(0);
    expect(host.runs).toEqual([]);
  });

  it("fails a call that is in flight when the turn is aborted", async () => {
    const controller = new AbortController();
    const finish = gate();
    const slow = tool("add_node", async () => {
      controller.abort();
      await finish.opened;
      return "too late";
    });
    const host = scriptedAgentCli([{ call: "add_node", arguments: { nodeId: "abc" } }]);

    await withFlowToolServer(host, { tools: [slow], signal: controller.signal }, async (relay) => {
      await spawn(host)(relay);
      finish.open();
    });

    // The CLI is not left waiting on a tool with nowhere to run.
    expect(host.toolResults).toEqual([{ name: "add_node", error: "the Ask AI turn ended" }]);
  });
});
