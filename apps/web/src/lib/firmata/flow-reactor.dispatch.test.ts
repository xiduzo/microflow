import { describe, expect, test } from "bun:test";
import { FlowReactor } from "./flow-reactor";
import type { FlowRuntimeCalls } from "./runtime-bridge";
import type { BoardConnection } from "./web-serial";

// Hotkeys in the browser reach the runtime through `dispatchToNode` (the twin of
// the desktop host's `ActorMsg::Key`). Assert the crossing: the right port, the
// value as JSON, and the effects the turn produced fed back to the sink.

function fakeConnection(): BoardConnection {
  return {
    session: { pinsJson: () => "[]" },
    write: () => Promise.resolve(),
  } as unknown as BoardConnection;
}

describe("FlowReactor.dispatchToNode", () => {
  test("calls the runtime's dispatch with the port and a JSON value", async () => {
    const calls: Array<[string, string, string]> = [];
    const runtime = {
      setPins: () => undefined,
      dispatch: (id: string, method: string, valueJson: string) => {
        calls.push([id, method, valueJson]);
        return "";
      },
    } as unknown as FlowRuntimeCalls;

    const reactor = await FlowReactor.attach(fakeConnection(), undefined, { runtime });
    reactor.dispatchToNode("hotkey-1", "key_event", true);
    reactor.dispatchToNode("hotkey-1", "key_event", false);

    expect(calls).toEqual([
      ["hotkey-1", "key_event", "true"],
      ["hotkey-1", "key_event", "false"],
    ]);
    reactor.dispose();
  });

  test("runs with no board: seeds an empty pin table and drops outbound bytes", async () => {
    const pinsSeeded: string[] = [];
    const runtime = {
      setPins: (pinsJson: string) => pinsSeeded.push(pinsJson),
      dispatch: () =>
        // One turn's effects: bytes for a board that is not there.
        JSON.stringify({
          outboundBytes: [0x90, 0x01, 0x00],
          componentEvents: [],
          wakeups: [],
          cancellations: [],
          cloudRequests: [],
          nodeDiagnostics: [],
        }),
    } as unknown as FlowRuntimeCalls;

    const reactor = await FlowReactor.attach(null, undefined, { runtime });
    expect(pinsSeeded).toEqual(["[]"]);
    // The bytes have nowhere to go; this must not throw on a null connection.
    reactor.dispatchToNode("hotkey-1", "key_event", true);
    reactor.dispose();
  });

  test("is a no-op once disposed rather than throwing at a key press", async () => {
    let called = 0;
    const runtime = {
      setPins: () => undefined,
      dispatch: () => {
        called += 1;
        return "";
      },
    } as unknown as FlowRuntimeCalls;

    const reactor = await FlowReactor.attach(fakeConnection(), undefined, { runtime });
    reactor.dispose();
    reactor.dispatchToNode("hotkey-1", "key_event", true);

    expect(called).toBe(0);
  });
});
