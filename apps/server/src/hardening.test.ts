import { describe, expect, test } from "bun:test";
import { redactSecrets } from "./log-redaction";
import { installShutdownHook, type SignalTarget } from "./shutdown";

describe("redactSecrets", () => {
  test("masks the bearer token the desktop app sends on the yjs upgrade", () => {
    expect(redactSecrets("<-- GET /yjs/flow-1?token=abc.def-123")).toBe(
      "<-- GET /yjs/flow-1?token=[redacted]",
    );
  });

  test("masks it among other parameters and keeps the rest", () => {
    expect(redactSecrets("--> GET /yjs/f?x=1&token=secret&y=2 101 3ms")).toBe(
      "--> GET /yjs/f?x=1&token=[redacted]&y=2 101 3ms",
    );
    expect(redactSecrets("GET /a?access_token=s3cr3t")).toBe("GET /a?access_token=[redacted]");
  });

  test("leaves lines without credentials alone", () => {
    expect(redactSecrets("<-- POST /trpc/flow.get?batch=1")).toBe(
      "<-- POST /trpc/flow.get?batch=1",
    );
  });
});

function fakeProcess() {
  const listeners = new Map<string, () => void>();
  const target: SignalTarget = {
    on: (signal, listener) => listeners.set(signal, listener),
  };
  return { target, emit: (signal: string) => listeners.get(signal)?.() };
}

describe("installShutdownHook", () => {
  test("drains the rooms, then exits cleanly", async () => {
    const calls: string[] = [];
    const { target, emit } = fakeProcess();
    const exited = new Promise<number>((resolve) => {
      installShutdownHook(
        async (timeoutMs) => {
          calls.push(`drain ${timeoutMs}`);
          return { unsaved: [] };
        },
        target,
        { timeoutMs: 8_000, exit: resolve },
      );
    });

    emit("SIGTERM");
    expect(await exited).toBe(0);
    expect(calls).toEqual(["drain 8000"]);
  });

  test("exits non-zero when a room could not be saved", async () => {
    const { target, emit } = fakeProcess();
    const exited = new Promise<number>((resolve) => {
      installShutdownHook(async () => ({ unsaved: ["flow-1"] }), target, {
        timeoutMs: 10,
        exit: resolve,
      });
    });

    emit("SIGINT");
    expect(await exited).toBe(1);
  });

  test("a second signal does not start a second drain", async () => {
    let drains = 0;
    let release!: () => void;
    const { target, emit } = fakeProcess();
    const exits: number[] = [];
    installShutdownHook(
      async () => {
        drains++;
        await new Promise<void>((resolve) => (release = resolve));
        return { unsaved: [] };
      },
      target,
      { timeoutMs: 10, exit: (code) => exits.push(code) },
    );

    emit("SIGTERM");
    emit("SIGINT");
    release();
    await Bun.sleep(0);

    expect(drains).toBe(1);
    expect(exits).toEqual([0]);
  });
});
