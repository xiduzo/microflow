import { describe, expect, spyOn, test } from "bun:test";
import { FlowReactor, type CloudDeps } from "./flow-reactor";
import type { FlowRuntimeCalls } from "./runtime-bridge";
import type { BoardConnection } from "@/board/web-serial";

// Host-originated input reaches the runtime through the reactor: a value for
// one node's port through `dispatchToNode` (the twin of the desktop
// `component_call`), a hotkey through `keyEvent` (the twin of `ActorMsg::Key`).
// Assert the crossing: what goes in, and the effects the turn produced fed back
// to the sink.

function fakeConnection(): BoardConnection {
  return {
    pinSeed: "[]",
    write: () => Promise.resolve(),
  } as unknown as BoardConnection;
}

describe("FlowReactor host input", () => {
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
    reactor.dispatchToNode("music-1", "play", true);
    reactor.dispatchToNode("music-1", "stop", false);

    expect(calls).toEqual([
      ["music-1", "play", "true"],
      ["music-1", "stop", "false"],
    ]);
    reactor.dispose();
  });

  test("a hotkey crosses as its accelerator: the runtime picks the nodes", async () => {
    const calls: Array<[string, boolean]> = [];
    const written: number[][] = [];
    const runtime = {
      setPins: () => undefined,
      keyEvent: (accelerator: string, pressed: boolean) => {
        calls.push([accelerator, pressed]);
        // The turn's effects: whatever the listening nodes drove.
        return JSON.stringify({
          outboundBytes: pressed ? [0x90, 0x01, 0x00] : [],
          componentEvents: [],
          wakeups: [],
          cancellations: [],
          cloudRequests: [],
          nodeDiagnostics: [],
        });
      },
    } as unknown as FlowRuntimeCalls;
    const connection = {
      pinSeed: "[]",
      write: (bytes: Uint8Array) => {
        written.push([...bytes]);
        return Promise.resolve();
      },
    } as unknown as BoardConnection;

    const reactor = await FlowReactor.attach(connection, undefined, { runtime });
    reactor.keyEvent("Mod+K", true);
    reactor.keyEvent("Mod+K", false);

    expect(calls).toEqual([
      ["Mod+K", true],
      ["Mod+K", false],
    ]);
    expect(written).toEqual([[0x90, 0x01, 0x00]]);
    reactor.dispose();
  });

  test("applyFlow reports the runtime's verdict instead of a blanket success", async () => {
    const empty = JSON.stringify({
      outboundBytes: [],
      componentEvents: [],
      wakeups: [],
      cancellations: [],
      cloudRequests: [],
      nodeDiagnostics: [],
    });
    let reject = false;
    const runtime = {
      setPins: () => undefined,
      updateFlow: () => {
        if (reject) throw new Error("unknown node type 'Bogus'");
        return empty;
      },
      // No `reconcileSubscriptions`: the bridge contains that fault, so the
      // reconcile stops before the cloud performer (which needs the wasm
      // module) — and its fault must not become applyFlow's verdict.
    } as unknown as FlowRuntimeCalls;

    const reactor = await FlowReactor.attach(fakeConnection(), undefined, { runtime });
    const flow = { nodes: [], edges: [] };
    expect(reactor.applyFlow(flow)).toEqual({ ok: true });

    reject = true;
    const result = reactor.applyFlow(flow);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("unknown node type 'Bogus'");

    reactor.dispose();
    expect(reactor.applyFlow(flow).ok).toBe(false);
  });

  test("an update that traps reports the trap, whatever the host does about it", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const runtime = {
        setPins: () => undefined,
        updateFlow: () => {
          throw new WebAssembly.RuntimeError("unreachable executed");
        },
      } as unknown as FlowRuntimeCalls;
      let reactor: FlowReactor | undefined;
      // A host that still talks to the reactor while it handles the fault:
      // the call finds the bridge closed, a fault of its own.
      reactor = await FlowReactor.attach(null, undefined, {
        runtime,
        onEngineFault: () => reactor?.keyEvent("Mod+K", false),
      });

      expect(reactor.applyFlow({ nodes: [], edges: [] })).toEqual({
        ok: false,
        error: "unreachable executed",
      });
      reactor.dispose();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
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
    reactor.dispatchToNode("music-1", "play", true);
    reactor.dispose();
  });

  test("is a no-op once disposed rather than throwing at a key press", async () => {
    let called = 0;
    const count = () => {
      called += 1;
      return "";
    };
    const runtime = {
      setPins: () => undefined,
      dispatch: count,
      keyEvent: count,
    } as unknown as FlowRuntimeCalls;

    const reactor = await FlowReactor.attach(fakeConnection(), undefined, { runtime });
    reactor.dispose();
    reactor.dispatchToNode("music-1", "play", true);
    reactor.keyEvent("Mod+K", true);

    expect(called).toBe(0);
  });
});

describe("FlowReactor.dispose", () => {
  /** A stand-in for `HTMLAudioElement`: what the audio performer drives. */
  class FakeAudio {
    static playing: FakeAudio[] = [];
    paused = true;
    loop = false;
    volume = 1;
    currentTime = 0;
    constructor(public src: string) {
      FakeAudio.playing.push(this);
    }
    addEventListener(): void {}
    play(): Promise<void> {
      this.paused = false;
      return Promise.resolve();
    }
    pause(): void {
      this.paused = true;
    }
  }

  test("every teardown step runs when the first one throws", async () => {
    const realAudio = globalThis.Audio;
    const realMidi = navigator.requestMIDIAccess;
    globalThis.Audio = FakeAudio as unknown as typeof Audio;
    const input = { name: "Launchpad Mini", onmidimessage: null as unknown };
    navigator.requestMIDIAccess = (() =>
      Promise.resolve({
        inputs: { values: () => [input] },
        outputs: { values: () => [] },
        onstatechange: null,
      })) as unknown as typeof navigator.requestMIDIAccess;
    try {
      let dispatched = 0;
      const runtime = {
        setPins: () => undefined,
        // The flow starts its Music node playing, and listens to MIDI.
        updateFlow: () =>
          JSON.stringify({
            outboundBytes: [],
            componentEvents: [],
            wakeups: [],
            cancellations: [],
            cloudRequests: [{ source: "music-1", kind: "audioPlay", track: 0, volume: 1, loop: true }],
            nodeDiagnostics: [],
          }),
        reconcileSubscriptions: () => "[]",
        listensToMidi: () => true,
        wantsMidiInput: () => true,
        dispatch: () => {
          dispatched += 1;
          return "";
        },
      } as unknown as FlowRuntimeCalls;
      const cloud: CloudDeps = {
        resolveLlmProvider: () => undefined,
        resolveBroker: () => undefined,
        // The cloud performer's teardown fails at its first step.
        watchBrokers: () => () => {
          throw new Error("the broker store is gone");
        },
      };
      const reactor = await FlowReactor.attach(null, cloud, { runtime });
      reactor.applyFlow({
        nodes: [
          {
            id: "music-1",
            type: "Music",
            data: { tracks: [{ src: "data:audio/wav;base64,AA==" }] },
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
      } as never);
      // The MIDI access is asked for, then the input is listened to.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const [track] = FakeAudio.playing;
      expect(track?.paused).toBe(false);
      expect(input.onmidimessage).not.toBeNull();

      expect(() => reactor.dispose()).toThrow("the broker store is gone");

      // MIDI, audio and the runtime were let go of all the same.
      expect(input.onmidimessage).toBeNull();
      expect(track?.paused).toBe(true);
      reactor.dispatchToNode("music-1", "play", true);
      expect(dispatched).toBe(0);
    } finally {
      globalThis.Audio = realAudio;
      navigator.requestMIDIAccess = realMidi;
    }
  });
});

describe("FlowReactor.attach and the broker settings watch", () => {
  /** Cloud lookups that count who watches the broker settings. */
  function watchedCloud() {
    const seen = { watching: 0 };
    const cloud: CloudDeps = {
      resolveLlmProvider: () => undefined,
      resolveBroker: () => undefined,
      watchBrokers: () => {
        seen.watching += 1;
        return () => {
          seen.watching -= 1;
        };
      },
    };
    return { cloud, seen };
  }

  test("a reactor watches the broker settings until it is disposed", async () => {
    const { cloud, seen } = watchedCloud();
    const runtime = { setPins: () => undefined } as unknown as FlowRuntimeCalls;

    const reactor = await FlowReactor.attach(null, cloud, { runtime });
    expect(seen.watching).toBe(1);

    reactor.dispose();
    expect(seen.watching).toBe(0);
  });

  test("an attach whose engine fails to load leaves nothing watching", async () => {
    const { cloud, seen } = watchedCloud();
    // Stands in for the wasm module failing to load: the failure comes at the
    // point where `attach` obtains its runtime.
    const failing = {
      get runtime(): FlowRuntimeCalls {
        throw new Error("the wasm module did not load");
      },
    };

    await expect(FlowReactor.attach(null, cloud, failing)).rejects.toThrow(
      "the wasm module did not load",
    );
    expect(seen.watching).toBe(0);
  });
});
