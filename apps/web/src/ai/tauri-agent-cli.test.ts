// The desktop adapter's wire, pinned on both sides.
//
// `createTauriAgentCli` is handed recording stand-ins for its Tauri primitives,
// so every command name, argument name and event name it sends is asserted
// here. Those names are then checked against the Rust source they have to
// match: the `#[tauri::command]` signatures, the handler list in `lib.rs`, the
// wire structs and the `emit` call. A rename on either side fails this file
// instead of shipping as a tool call that times out in the real app.

import { describe, expect, it } from "bun:test";

import type { ToolCall } from "./agent-cli-port";
import { createTauriAgentCli, type TauriPrimitives } from "./tauri-agent-cli";

// ---------------------------------------------------------------------------
// Recording primitives
// ---------------------------------------------------------------------------

type Listener = { event: string; handler: (event: { payload: unknown }) => void };

/**
 * Tauri, recorded. `answers` is what each command resolves with; an `Error`
 * rejects instead. `generate` is what `invokeCommand` answers for a run, or a
 * promise of it for a process that is still going.
 */
function recordingTauri(
  answers: Record<string, unknown> = {},
  generate: unknown = { success: true, data: "" },
) {
  const commands: Array<{ type: string; [argument: string]: unknown }> = [];
  const invocations: Array<{ command: string; args: unknown }> = [];
  const listeners: Listener[] = [];

  const tauri = {
    invokeCommand: async (command: { type: string }) => {
      commands.push(command);
      return command.type === "llm_cli_generate" ? generate : { success: true };
    },
    invoke: async (command: string, args: unknown) => {
      invocations.push({ command, args });
      const answer = answers[command];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    listen: async (event: string, handler: Listener["handler"]) => {
      const listener = { event, handler };
      listeners.push(listener);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    },
  } as unknown as TauriPrimitives;

  return { tauri, commands, invocations, listeners };
}

// ---------------------------------------------------------------------------
// The Rust side, read from source
// ---------------------------------------------------------------------------

const RUST = `${import.meta.dir}/../../src-tauri/src`;
const rust = (file: string) => Bun.file(`${RUST}/${file}`).text();

/** Tauri hands a command's arguments over under camelCase names. */
const camel = (name: string) => name.replace(/_(\w)/g, (_, letter: string) => letter.toUpperCase());

/** The arguments a caller must send to `#[tauri::command] fn <name>`: every
 *  parameter but the ones Tauri injects itself. */
function commandArgs(source: string, name: string): string[] {
  const signature = new RegExp(
    `#\\[tauri::command\\]\\s*pub (?:async )?fn ${name}\\s*\\(([^)]*)\\)`,
  ).exec(source);
  if (!signature) throw new Error(`no #[tauri::command] fn ${name} in the Rust source`);
  return [...signature[1].matchAll(/(\w+)\s*:\s*((?:[^,<]|<[^>]*>)+)/g)]
    .filter(([, , type]) => !/^(tauri::)?(State|AppHandle)\b/.test(type.trim()))
    .map(([, param]) => camel(param));
}

/** The field names a `Serialize`/`Deserialize` struct has on the wire. */
function wireFields(source: string, name: string): string[] {
  const body = new RegExp(`pub struct ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source);
  if (!body) throw new Error(`no struct ${name} in the Rust source`);
  const fields: string[] = [];
  let renamed: string | undefined;
  for (const line of body[1].split("\n")) {
    const rename = /#\[serde\(rename = "(\w+)"\)\]/.exec(line);
    const field = /^\s*pub (\w+):/.exec(line);
    if (rename) renamed = rename[1];
    if (field) {
      fields.push(renamed ?? field[1]);
      renamed = undefined;
    }
  }
  return fields;
}

const keys = (value: unknown) => Object.keys(value as object).sort();

// ---------------------------------------------------------------------------

const RELAY = { bin: "/Applications/Microflow.app/Contents/MacOS/Microflow", args: ["--mcp", "t"] };
const SPEC = { name: "add_node", description: "Add a node", inputSchema: { type: "object" } };

describe("run", () => {
  const invocation = { bin: "claude", args: ["-p", "--model", "sonnet"], stdin: "add an LED" };

  it("sends `llm_cli_generate` the binary, the arguments and the prompt", async () => {
    const { tauri, commands } = recordingTauri({}, { success: true, data: "Done." });

    expect(await createTauriAgentCli(tauri).run(invocation)).toBe("Done.");

    expect(commands).toEqual([
      {
        type: "llm_cli_generate",
        run: expect.any(String),
        bin: "claude",
        args: ["-p", "--model", "sonnet"],
        prompt: "add an LED",
      },
    ]);
  });

  it("names the command and the arguments `cli_llm.rs` takes", async () => {
    const { tauri, commands } = recordingTauri();
    await createTauriAgentCli(tauri).run(invocation);

    // `invokeCommand` sends `type` as the command name and the rest as its
    // arguments.
    const { type, ...args } = commands[0];
    expect(keys(args)).toEqual(commandArgs(await rust("cli_llm.rs"), type).sort());
    expect(await rust("lib.rs")).toContain(`cli_llm::${type},`);
  });

  it("gives every run a name of its own", async () => {
    const { tauri, commands } = recordingTauri();
    const port = createTauriAgentCli(tauri);

    await port.run(invocation);
    await port.run(invocation);

    const [first, second] = commands.map((command) => command.run as string);
    expect(first.length).toBeGreaterThan(0);
    expect(second).not.toBe(first);
  });

  it("rejects with the host's own message when the run fails", async () => {
    const { tauri } = recordingTauri({}, { success: false, error: "claude: not logged in" });

    await expect(createTauriAgentCli(tauri).run(invocation)).rejects.toThrow(
      new Error("claude: not logged in"),
    );
  });

  it("answers with a string whatever the command resolved with", async () => {
    const answerFor = (response: unknown) =>
      createTauriAgentCli(recordingTauri({}, response).tauri).run(invocation);

    expect(await answerFor({ success: true })).toBe("");
    expect(await answerFor({ success: true, data: null })).toBe("");
    expect(await answerFor({ success: true, data: 42 })).toBe("42");
    expect(await answerFor({ success: true, data: "" })).toBe("");
  });
});

describe("run, when its signal aborts", () => {
  const invocation = { bin: "claude", args: ["-p"], stdin: "add an LED" };

  /** A process that is still going until the test says how it ended. */
  function running() {
    let exit!: (response: unknown) => void;
    const exited = new Promise<unknown>((resolve) => {
      exit = resolve;
    });
    return { exited, exit };
  }

  it("sends `llm_cli_stop` the run it started, and rejects with the signal's reason", async () => {
    const process = running();
    const { tauri, commands } = recordingTauri({}, process.exited);
    const controller = new AbortController();
    const reason = new Error("stopped by the user");

    const run = createTauriAgentCli(tauri).run({ ...invocation, signal: controller.signal });
    await Promise.resolve();
    controller.abort(reason);

    // At the stop, not when the host gets round to answering for the run.
    await expect(run).rejects.toBe(reason);
    expect(commands.map((command) => command.type)).toEqual(["llm_cli_generate", "llm_cli_stop"]);
    expect(commands[1]).toEqual({ type: "llm_cli_stop", run: commands[0].run });
  });

  it("names the stop command and the argument `cli_llm.rs` takes", async () => {
    const { tauri, commands } = recordingTauri({}, running().exited);
    const controller = new AbortController();

    const run = createTauriAgentCli(tauri).run({ ...invocation, signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await run.catch(() => {});

    const { type, ...args } = commands[1];
    expect(keys(args)).toEqual(commandArgs(await rust("cli_llm.rs"), type).sort());
    expect(await rust("lib.rs")).toContain(`cli_llm::${type},`);
  });

  it("returns nothing a stopped run printed, whatever the host answers for it later", async () => {
    const process = running();
    const { tauri } = recordingTauri({}, process.exited);
    const controller = new AbortController();
    const reason = new Error("stopped by the user");

    const run = createTauriAgentCli(tauri).run({ ...invocation, signal: controller.signal });
    await Promise.resolve();
    controller.abort(reason);
    process.exit({ success: true, data: "An answer nobody is waiting for." });

    await expect(run).rejects.toBe(reason);
  });

  it("starts nothing when the signal has already aborted", async () => {
    const { tauri, commands } = recordingTauri();
    const controller = new AbortController();
    const reason = new Error("stopped by the user");
    controller.abort(reason);

    await expect(
      createTauriAgentCli(tauri).run({ ...invocation, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(commands).toEqual([]);
  });

  it("sends no stop for a run that has already ended, so a late stop cannot reach another run", async () => {
    const { tauri, commands } = recordingTauri({}, { success: true, data: "Done." });
    const controller = new AbortController();

    expect(
      await createTauriAgentCli(tauri).run({ ...invocation, signal: controller.signal }),
    ).toBe("Done.");
    controller.abort();
    await Promise.resolve();

    expect(commands.map((command) => command.type)).toEqual(["llm_cli_generate"]);
  });

  it("sends no stop for a run that failed", async () => {
    const { tauri, commands } = recordingTauri({}, { success: false, error: "claude: not logged in" });
    const controller = new AbortController();

    await expect(
      createTauriAgentCli(tauri).run({ ...invocation, signal: controller.signal }),
    ).rejects.toThrow("claude: not logged in");
    controller.abort();
    await Promise.resolve();

    expect(commands.map((command) => command.type)).toEqual(["llm_cli_generate"]);
  });
});

describe("openSession", () => {
  const session = { token: "t0k3n", tools: [SPEC], budget: 40 };

  it("sends `mcp_session_start` the token, the roster and the budget, and nothing else", async () => {
    const { tauri, invocations } = recordingTauri({ mcp_session_start: RELAY });

    const relay = await createTauriAgentCli(tauri).openSession({
      ...session,
      // A field the port does not name must not reach the host.
      ...({ extra: true } as object),
    });

    expect(relay).toEqual(RELAY);
    expect(invocations).toEqual([
      { command: "mcp_session_start", args: { token: "t0k3n", tools: [SPEC], budget: 40 } },
    ]);
  });

  it("answers `null` when the host has nothing listening", async () => {
    const { tauri } = recordingTauri({ mcp_session_start: null });

    expect(await createTauriAgentCli(tauri).openSession(session)).toBeNull();
  });

  it("names the arguments and the structs `session.rs` takes and answers with", async () => {
    const { tauri, invocations } = recordingTauri({ mcp_session_start: RELAY });
    await createTauriAgentCli(tauri).openSession(session);
    const source = await rust("mcp/session.rs");

    expect(keys(invocations[0].args)).toEqual(commandArgs(source, "mcp_session_start").sort());
    expect(keys(SPEC)).toEqual(wireFields(source, "ToolSpec").sort());
    expect(keys(RELAY)).toEqual(wireFields(source, "RelayCommand").sort());
  });
});

describe("onToolCall", () => {
  const call: ToolCall = { id: 7, name: "add_node", arguments: { type: "Led" } };

  it("listens for `mcp-request` and hands on the payload of each event", async () => {
    const { tauri, listeners } = recordingTauri();
    const heard: ToolCall[] = [];

    await createTauriAgentCli(tauri).onToolCall((received) => heard.push(received));

    expect(listeners.map((listener) => listener.event)).toEqual(["mcp-request"]);
    listeners[0].handler({ payload: call });
    expect(heard).toEqual([call]);
  });

  it("answers with the function that stops listening", async () => {
    const { tauri, listeners } = recordingTauri();

    const unsubscribe = await createTauriAgentCli(tauri).onToolCall(() => {});
    unsubscribe();

    expect(listeners).toEqual([]);
  });

  it("names the event and the fields `session.rs` emits", async () => {
    const { tauri, listeners } = recordingTauri();
    await createTauriAgentCli(tauri).onToolCall(() => {});

    const emitted = /\.emit\(\s*"([^"]+)",\s*json!\(\{([^}]*)\}\)/.exec(
      await rust("mcp/session.rs"),
    );
    expect(emitted?.[1]).toBe(listeners[0].event);
    const fields = [...(emitted?.[2] ?? "").matchAll(/"(\w+)"\s*:/g)].map(([, field]) => field);
    expect(fields.sort()).toEqual(keys(call));
  });
});

describe("answerToolCall", () => {
  it("sends `mcp_tool_result` a result with a null error", async () => {
    const { tauri, invocations } = recordingTauri();

    await createTauriAgentCli(tauri).answerToolCall(7, { result: { ok: true } });

    expect(invocations).toEqual([
      { command: "mcp_tool_result", args: { id: 7, result: { ok: true }, error: null } },
    ]);
  });

  it("sends a tool that returned nothing as a null result", async () => {
    const { tauri, invocations } = recordingTauri();

    await createTauriAgentCli(tauri).answerToolCall(7, { result: undefined });

    expect(invocations[0].args).toEqual({ id: 7, result: null, error: null });
  });

  it("sends `mcp_tool_result` an error with a null result", async () => {
    const { tauri, invocations } = recordingTauri();

    await createTauriAgentCli(tauri).answerToolCall(8, { error: "the pin is taken" });

    expect(invocations).toEqual([
      { command: "mcp_tool_result", args: { id: 8, result: null, error: "the pin is taken" } },
    ]);
  });

  it("rejects when the host cannot be told, so the caller can decide what that means", async () => {
    const { tauri } = recordingTauri({ mcp_tool_result: new Error("the window is gone") });

    await expect(createTauriAgentCli(tauri).answerToolCall(7, { result: 1 })).rejects.toThrow(
      "the window is gone",
    );
  });
});

describe("closeSession", () => {
  it("sends `mcp_session_end` the token that opened", async () => {
    const { tauri, invocations } = recordingTauri();

    await createTauriAgentCli(tauri).closeSession("t0k3n");

    expect(invocations).toEqual([{ command: "mcp_session_end", args: { token: "t0k3n" } }]);
  });
});

describe("the commands the adapter invokes", () => {
  it("exist in `session.rs` with these arguments, and are registered in `lib.rs`", async () => {
    const { tauri, invocations } = recordingTauri({ mcp_session_start: RELAY });
    const port = createTauriAgentCli(tauri);
    await port.openSession({ token: "t", tools: [SPEC], budget: 40 });
    await port.answerToolCall(1, { result: "ok" });
    await port.answerToolCall(2, { error: "no" });
    await port.closeSession("t");

    const source = await rust("mcp/session.rs");
    const handlers = await rust("lib.rs");
    expect(invocations.map(({ command }) => command)).toEqual([
      "mcp_session_start",
      "mcp_tool_result",
      "mcp_tool_result",
      "mcp_session_end",
    ]);
    for (const { command, args } of invocations) {
      expect(keys(args)).toEqual(commandArgs(source, command).sort());
      expect(handlers).toContain(`mcp::session::${command},`);
    }
  });
});
