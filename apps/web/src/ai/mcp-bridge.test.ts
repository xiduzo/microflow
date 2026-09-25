import { describe, expect, it, mock, beforeEach } from "bun:test";
import { z } from "zod";

/** Every `invoke` the bridge made, in order. */
let invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
/** What `mcp_session_start` answers — `null` stands for "nothing is listening". */
let relay: { bin: string; args: string[] } | null = { bin: "/bin/microflow", args: ["--mcp", "t"] };

const invoke = mock(async (command: string, args: Record<string, unknown>) => {
  invocations.push({ command, args });
  return command === "mcp_session_start" ? relay : null;
});
mock.module("@tauri-apps/api/core", () => ({ invoke }));

/** The live `mcp-request` listeners, so a test can play the Rust side. */
let listeners: Array<(event: { payload: unknown }) => void> = [];
const listen = mock(async (_event: string, handler: (event: { payload: unknown }) => void) => {
  listeners.push(handler);
  return () => {
    listeners = listeners.filter((entry) => entry !== handler);
  };
});
mock.module("@tauri-apps/api/event", () => ({ listen }));

const { withFlowToolServer, CALL_BUDGET } = await import("./mcp-bridge");

/** A tool shaped like the ones `createFlowTools` returns. */
function tool(name: string, run: (args: unknown) => unknown) {
  return {
    name,
    description: `the ${name} tool`,
    inputSchema: z.object({ nodeId: z.string() }),
    execute: run,
  } as never;
}

/** Deliver one `mcp-request` to whatever is listening and let it settle. */
async function callTool(id: number, name: string, args: unknown) {
  for (const handler of [...listeners]) handler({ payload: { id, name, arguments: args } });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const results = () => invocations.filter((entry) => entry.command === "mcp_tool_result");

beforeEach(() => {
  invocations = [];
  listeners = [];
  relay = { bin: "/bin/microflow", args: ["--mcp", "t"] };
});

describe("withFlowToolServer", () => {
  it("publishes each tool with JSON Schema derived from its own zod schema", async () => {
    await withFlowToolServer({ tools: [tool("add_node", () => "ok")] }, async () => undefined);

    const start = invocations.find((entry) => entry.command === "mcp_session_start");
    const [spec] = start?.args.tools as Array<{ name: string; inputSchema: Record<string, unknown> }>;
    expect(spec.name).toBe("add_node");
    // Not a hand-written schema: what the CLI is shown is what the call is
    // validated against, so the two cannot drift.
    expect(spec.inputSchema.type).toBe("object");
    expect(Object.keys(spec.inputSchema.properties as object)).toEqual(["nodeId"]);
    expect(start?.args.budget).toBe(CALL_BUDGET);
  });

  it("runs the tool the CLI called and answers with its result", async () => {
    await withFlowToolServer({ tools: [tool("add_node", (args) => ({ got: args }))] }, async () => {
      await callTool(1, "add_node", { nodeId: "abc" });
    });

    expect(results()).toEqual([
      { command: "mcp_tool_result", args: { id: 1, result: { got: { nodeId: "abc" } }, error: null } },
    ]);
  });

  it("reports a thrown tool as a tool error, never as a failed turn", async () => {
    const boom = tool("add_node", () => {
      throw new Error("the pin is taken");
    });
    // The whole point: the CLI reads this and tries something else.
    await withFlowToolServer({ tools: [boom] }, async () => {
      await callTool(1, "add_node", { nodeId: "abc" });
    });

    expect(results()[0].args).toEqual({ id: 1, result: null, error: "the pin is taken" });
  });

  it("rejects arguments the tool's schema does not accept, by name", async () => {
    const ran = mock(() => "should not run");
    await withFlowToolServer({ tools: [tool("add_node", ran)] }, async () => {
      await callTool(1, "add_node", {});
    });

    expect(ran).not.toHaveBeenCalled();
    expect(String(results()[0].args.error)).toContain("nodeId");
  });

  it("names an unknown tool rather than hanging on it", async () => {
    await withFlowToolServer({ tools: [tool("add_node", () => "ok")] }, async () => {
      await callTool(1, "delete_everything", {});
    });

    expect(String(results()[0].args.error)).toContain("delete_everything");
  });

  it("closes the session even when the run throws", async () => {
    // An aborted turn must not leave the tools published — the session's
    // lifetime is the security boundary, not the happy path.
    await expect(
      withFlowToolServer({ tools: [tool("add_node", () => "ok")] }, async () => {
        throw new Error("the user pressed stop");
      }),
    ).rejects.toThrow("the user pressed stop");

    expect(invocations.at(-1)?.command).toBe("mcp_session_end");
    expect(listeners).toHaveLength(0);
  });

  it("lets only the newest session act, so a write cannot land twice", async () => {
    // Tauri events are broadcast by name. Two live listeners would both run
    // `add_node` for one call and the flow would gain two nodes.
    const ran = mock(() => "ok");
    await withFlowToolServer({ tools: [tool("add_node", ran)] }, async (_relay) => {
      const stale = listeners[0];
      await withFlowToolServer({ tools: [tool("add_node", ran)] }, async () => {
        // Both the outer turn's listener and the inner one are hearing this.
        listeners.push(stale);
        await callTool(1, "add_node", { nodeId: "abc" });
      });
    });

    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("closes the session the moment the turn is aborted", async () => {
    // The CLI is a subprocess we cannot interrupt, so ending the session is the
    // stop button: whatever it decides next, it can no longer reach the flow.
    const controller = new AbortController();
    const ran = mock(() => "ok");
    await withFlowToolServer(
      { tools: [tool("add_node", ran)], signal: controller.signal },
      async () => {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(invocations.at(-1)?.command).toBe("mcp_session_end");
        await callTool(1, "add_node", { nodeId: "abc" });
      },
    );

    expect(ran).not.toHaveBeenCalled();
    // Closed once, not once per unwind path.
    expect(invocations.filter((entry) => entry.command === "mcp_session_end")).toHaveLength(1);
  });

  it("falls back to a prose turn when nothing is listening", async () => {
    relay = null;
    const seen: Array<unknown> = [];
    await withFlowToolServer({ tools: [tool("add_node", () => "ok")] }, async (given) => {
      seen.push(given);
      // Nothing published, so nothing to listen for and nothing to close.
      expect(listeners).toHaveLength(0);
    });

    // `undefined` is the signal to run the CLI without an MCP server rather
    // than an error — the platform simply has no transport.
    expect(seen).toEqual([undefined]);
    expect(invocations.map((entry) => entry.command)).toEqual(["mcp_session_start"]);
  });
});
