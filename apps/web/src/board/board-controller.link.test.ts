// The controller driving a real board link over the fake port: connection
// loss, retry backoff, engine fault, write failure, unplug and page lifecycle —
// the paths that had no test. The bring-up machine is a TS mimic of the
// transitions `microflow_core::bringup` makes for these events (the real one
// is wasm, and its own Rust tests pin it); everything below the controller is
// the production link.

import { describe, expect, test } from "bun:test";
import {
  BoardController,
  RETRY_CAP_MS,
  RETRY_MAX_ATTEMPTS,
  retryDelayMs,
  type BoardControllerDeps,
  type PageLifecycleHandlers,
  type ReactorHandle,
} from "./board-controller-core";
import { probeBoard, FIRMATA_SYSTEM_RESET, type BoardConnection, type ProbeEnv } from "./board-link";
import { watchConnectivity } from "./serial-port";
import {
  FakeClock,
  FakeSerial,
  FakeSerialPort,
  FakeSession,
  firmataDevice,
  flush,
} from "./link-fakes";
import type { BoardState } from "@/lib/bindings/BoardState";
import type { BringUpAction, BringUpEvent } from "./wasm";

const notify = (kind: "connecting" | "connected" | "disconnected"): BringUpAction => ({
  type: "notify",
  phase: { kind },
});

/** The bring-up machine's transitions for the events these tests raise. */
function machineMimic(): (event: BringUpEvent) => BringUpAction[] {
  let state: "idle" | "probing" | "connected" = "idle";
  return (event) => {
    const was = state;
    switch (event.type) {
      case "disconnectRequested":
        state = "idle";
        return was === "idle" ? [notify("disconnected")] : [{ type: "closePort" }, notify("disconnected")];
      case "portGone":
        state = "idle";
        if (was === "connected") return [{ type: "closePort" }, notify("disconnected")];
        return was === "idle" ? [] : [notify("disconnected")];
      case "connectionLost":
        if (was !== "connected") return [];
        state = "idle";
        return [{ type: "closePort" }, notify("disconnected"), { type: "scheduleRetry" }];
      case "portReady":
        if (was !== "idle") return [];
        state = "probing";
        return [notify("connecting"), { type: "probe", afterFlash: false }];
      case "probeOk":
        if (was !== "probing") return [];
        state = "connected";
        return [notify("connected")];
      case "probeFailed":
        if (was !== "probing") return [];
        state = "idle";
        return [notify("disconnected")];
      default:
        return [];
    }
  };
}

type FakeReactor = ReactorHandle & {
  connection: BoardConnection | null;
  fed: number[];
  disposed: boolean;
  fault: (message: string) => void;
};

function linked() {
  const clock = new FakeClock();
  const port = new FakeSerialPort();
  const serial = new FakeSerial([port]);
  const states: BoardState[] = [];
  const toasts: string[] = [];
  const reactors: FakeReactor[] = [];
  const scans: number[] = [];
  let pickerOpened = 0;
  let lifecycle: PageLifecycleHandlers | undefined;
  /** While set, a board-backed reactor's attach waits on it. */
  let attachGate: Promise<void> | null = null;
  let attachRequested = 0;

  const env: ProbeEnv = {
    clock,
    createSession: async () => new FakeSession().asSession(),
    listGrantedPorts: () => serial.getPorts(),
  };
  const machine = machineMimic();

  const deps: BoardControllerDeps = {
    serial: {
      isSupported: () => true,
      listGrantedPorts: async () => {
        scans.push(clock.now());
        return serial.getPorts();
      },
      requestBoardPort: () => {
        pickerOpened += 1;
        return serial.requestPort();
      },
      detectBoard: async () => "uno",
      probeFirmata: (p, hooks) => probeBoard(env, p, hooks, { afterFlash: false }),
      probeAfterFlash: (p, hooks) => probeBoard(env, p, hooks, { afterFlash: true }),
      flashPort: async () => "uno",
      onConnectivity: (handlers) => watchConnectivity(serial, handlers),
      portLabel: () => "USB 2341:0043",
      connectedState: () => ({
        state: "connected",
        port: "USB 2341:0043",
        firmwareName: "StandardFirmata.ino",
        firmwareVersion: "2.5",
        pins: [],
      }),
    },
    createMachine: async () => ({}) as never,
    handleEvent: (_machine, event) => machine(event),
    attachReactor: async (connection, hooks) => {
      if (connection) {
        attachRequested += 1;
        if (attachGate) await attachGate;
      }
      const reactor: FakeReactor = {
        connection,
        fed: [],
        disposed: false,
        fault: hooks.onEngineFault,
        applyFlow() {},
        feedBytes(bytes) {
          reactor.fed.push(...bytes);
        },
        dispatchToNode() {},
        dispose() {
          reactor.disposed = true;
        },
      };
      reactors.push(reactor);
      return reactor;
    },
    setBoard: (state) => states.push(state),
    notify: {
      loading: () => 1,
      success: () => {},
      error: (message) => void toasts.push(message),
      dismiss: () => {},
    },
    track: (() => {}) as never,
    clock,
    onPageLifecycle: (handlers) => {
      lifecycle = handlers;
      return () => {};
    },
    isDesktop: () => false,
  };

  const controller = new BoardController(deps);
  const h = {
    clock,
    port,
    serial,
    states,
    toasts,
    reactors,
    scans,
    controller,
    get pickerOpened() {
      return pickerOpened;
    },
    get attachRequested() {
      return attachRequested;
    },
    gateAttach(): () => void {
      let open!: () => void;
      attachGate = new Promise((resolve) => {
        open = resolve;
      });
      return () => {
        attachGate = null;
        open();
      };
    },
    lifecycle: () => lifecycle!,
    last: () => states.at(-1)?.state,
    boardReactor: () => reactors.findLast((r) => r.connection !== null),
    /** Run the queue (and the fake time it needs) dry. */
    settle: () => clock.run(controller.settled()),
    /** Start and wait for the load scan to connect the granted board. */
    async connected() {
      controller.start();
      await clock.until(() => states.at(-1)?.state === "connected" && !!h.boardReactor());
      await h.settle();
    },
  };
  return h;
}

describe("inbound bytes during attach", () => {
  test("arrive at the board runtime in order, none at the boardless one", async () => {
    const h = linked();
    const release = h.gateAttach();
    h.controller.start();
    await h.clock.until(() => h.attachRequested === 1);

    // The runtime is still loading; the board is already talking.
    h.port.emit(Uint8Array.of(10));
    h.port.emit(Uint8Array.of(11));
    await flush();
    release();
    await h.settle();
    h.port.emit(Uint8Array.of(12));
    await flush();

    expect(h.boardReactor()?.fed).toEqual([10, 11, 12]);
    const boardless = h.reactors.filter((r) => r.connection === null);
    expect(boardless.flatMap((r) => r.fed)).toEqual([]);
  });
});

describe("connection loss and retry", () => {
  test("a write failure mid-session reports disconnected, closes the port, and retries", async () => {
    const h = await (async () => {
      const h = linked();
      await h.connected();
      return h;
    })();
    const link = h.boardReactor()!.connection!;

    h.port.device = { ...firmataDevice(), failWrite: () => true };
    await link.write(Uint8Array.of(0x90, 1, 0)).catch(() => {});
    await h.settle();

    expect(h.last()).toBe("disconnected");
    expect(h.port.isOpen).toBe(false);
    expect(h.controller.retrying).toBe(true);

    // The first retry's probe hits the same failing writes: its port is closed
    // again, so the next attempt can open it once the board recovers.
    await h.clock.until(() => h.scans.length >= 3 && h.port.opens >= 3);
    await h.settle();
    expect(h.port.isOpen).toBe(false);
    h.port.device = firmataDevice();
    await h.clock.until(() => h.last() === "connected" && !h.controller.retrying);
    await h.settle();

    expect(h.port.isOpen).toBe(true);
    expect(h.boardReactor()?.connection).not.toBe(link);
  });

  test("backoff doubles from the base and is capped, then stops", async () => {
    const h = linked();
    await h.connected();
    const scansBefore = h.scans.length;

    // The board resets and does not come back.
    h.serial.granted = [];
    const lostAt = h.clock.now();
    h.port.unplug();
    await h.clock.until(() => !h.controller.retrying);

    const times = [lostAt, ...h.scans.slice(scansBefore)];
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    const expected = Array.from({ length: RETRY_MAX_ATTEMPTS }, (_, n) => retryDelayMs(n));
    expect(gaps).toEqual(expected);
    expect(expected.slice(0, 4)).toEqual([250, 500, 1000, 2000]);
    expect(Math.max(...gaps)).toBe(RETRY_CAP_MS);
  });

  test("an unplug event closes the port without a retry", async () => {
    const h = linked();
    await h.connected();

    h.serial.fire("disconnect", h.port);
    await h.settle();

    expect(h.last()).toBe("disconnected");
    expect(h.port.isOpen).toBe(false);
    expect(h.controller.retrying).toBe(false);
  });
});

describe("engine fault", () => {
  test("closes the port after resetting outputs, shows error, and refuses to reconnect", async () => {
    const h = linked();
    await h.connected();

    h.boardReactor()!.fault("The flow engine stopped: unreachable");
    expect(h.last()).toBe("error");
    await h.settle();

    expect(h.port.isOpen).toBe(false);
    expect(h.port.written.at(-1)?.at(-1)).toBe(FIRMATA_SYSTEM_RESET);
    // The machine's `disconnected` must not paint over the fault.
    expect(h.states.at(-1)).toEqual({ state: "error", error: "The flow engine stopped: unreachable" });
    expect(h.controller.retrying).toBe(false);

    // Neither a gesture nor a plug-in reopens the port into a dead engine.
    h.serial.picked = h.port;
    await h.controller.connect();
    h.serial.fire("connect", h.port);
    await h.settle();
    expect(h.pickerOpened).toBe(0);
    expect(h.port.isOpen).toBe(false);
    expect(h.toasts.at(-1)).toContain("Reload the page");
  });
});

describe("page lifecycle", () => {
  test("pagehide closes the port (outputs reset first); pageshow from the bfcache reconnects", async () => {
    const h = linked();
    await h.connected();

    h.lifecycle().onPageHide();
    await h.settle();
    expect(h.port.isOpen).toBe(false);
    expect(h.port.written.at(-1)?.at(-1)).toBe(FIRMATA_SYSTEM_RESET);
    expect(h.last()).toBe("disconnected");

    h.lifecycle().onPageShow(true);
    await h.clock.until(() => h.last() === "connected");
    await h.settle();
    expect(h.port.isOpen).toBe(true);
  });

  test("pagehide cancels a pending retry", async () => {
    const h = linked();
    await h.connected();
    h.port.unplug();
    await h.settle();
    expect(h.controller.retrying).toBe(true);

    h.lifecycle().onPageHide();
    expect(h.controller.retrying).toBe(false);
    await h.settle();
    expect(h.clock.pending).toBe(0);
  });
});
