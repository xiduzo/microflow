import { describe, expect, test } from "bun:test";
import type { BridgeSnapshotEntry } from "./bridge";
import { MSG, type MessageHandlers, type PluginMessage, messages } from "./rpc";
import { type SandboxAdapter, createSandboxBridge } from "./sandbox";

const led: BridgeSnapshotEntry = {
  variable: { id: "token-1", name: "led", resolvedType: "FLOAT" },
  value: 1,
};

/** The routing over `adapter`, with everything it tells its host recorded. */
function sandbox(adapter: Partial<SandboxAdapter>, glue: MessageHandlers = {}) {
  const sent: PluginMessage[] = [];
  const errors: Array<{ text: string; cause: unknown }> = [];
  const failures: string[] = [];
  const bridge = createSandboxBridge(
    { readSnapshot: () => [led], writeValue: () => null, ...adapter },
    {
      send: (message) => sent.push(message),
      reportError: (text, cause) => errors.push({ text, cause }),
      onFailure: (type, error) => failures.push(`${type}: ${String(error)}`),
    },
    glue,
  );
  return { ...bridge, sent, errors, failures };
}

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("sandbox routing", () => {
  test("answers the hello, then lets the host glue add to it", () => {
    const order: string[] = [];
    const { dispatch, sent } = sandbox({}, { [MSG.UI_READY]: () => void order.push(`after ${sent.length}`) });

    dispatch(messages.uiReady());
    expect(sent).toEqual([messages.uiReady()]);
    expect(order).toEqual(["after 1"]);
  });

  test("answers a snapshot request at once when the tool reads synchronously", () => {
    const { dispatch, sent } = sandbox({});
    dispatch(messages.getVariables());
    expect(sent).toEqual([messages.getVariables([led])]);
  });

  test("answers a snapshot request when the tool reads asynchronously", async () => {
    const { dispatch, sent } = sandbox({ readSnapshot: async () => [led] });
    dispatch(messages.getVariables());
    await settled();
    expect(sent).toEqual([messages.getVariables([led])]);
  });

  test("pushes a snapshot nobody asked for", () => {
    const { pushSnapshot, sent } = sandbox({});
    pushSnapshot();
    expect(sent).toEqual([messages.getVariables([led])]);
  });

  test("writes a value by ID and says nothing when the tool takes it", async () => {
    const writes: unknown[] = [];
    const { dispatch, sent, errors } = sandbox({
      writeValue: async (id, value) => {
        writes.push({ id, value });
        return null;
      },
    });

    dispatch(messages.setVariable("token-1", 0.5));
    await settled();
    expect(writes).toEqual([{ id: "token-1", value: 0.5 }]);
    expect(sent).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("reports a rejected write to the user", () => {
    const cause = new Error("read-only");
    const { dispatch, errors, failures } = sandbox({
      writeValue: () => ({ message: "led cannot hold that value", cause }),
    });

    dispatch(messages.setVariable("token-1", "red"));
    expect(errors).toEqual([{ text: "led cannot hold that value", cause }]);
    expect(failures).toEqual([]);
  });

  test("hands a tool that throws to the host's failure handler", async () => {
    const { dispatch, sent, failures } = sandbox({
      readSnapshot: () => {
        throw new Error("no file");
      },
      writeValue: async () => {
        throw new Error("no file");
      },
    });

    dispatch(messages.getVariables());
    dispatch(messages.setVariable("token-1", 1));
    await settled();
    expect(sent).toEqual([]);
    expect(failures).toEqual(["GET_VARIABLES: Error: no file", "SET_VARIABLE: Error: no file"]);
  });

  test("leaves host-only messages to the glue and ignores anything else", () => {
    const resized: unknown[] = [];
    const { dispatch, sent } = sandbox({}, { [MSG.RESIZE]: (size) => void resized.push(size) });

    dispatch(messages.resize(300, 200));
    dispatch(messages.openLink("https://microflow.tech/"));
    dispatch({ type: "SOMETHING_ELSE" });
    dispatch("not a message");
    expect(resized).toEqual([{ width: 300, height: 200 }]);
    expect(sent).toEqual([]);
  });
});
