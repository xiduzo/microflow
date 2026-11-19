// The controller driving a real board link over the fake port, with the real
// bring-up machine — `microflow_core::bringup` compiled to wasm, not a TS copy
// of it (a copy drifted once: its `probeFailed` never flashed, which hid a
// controller path that reflashed a working board). Covers connection loss,
// retry backoff, engine fault, write failure, unplug, page lifecycle, and
// explicit connects overtaken by either.
//
// Needs the generated module: `bun run build:wasm:firmata`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BringUpMachine, initSync } from "./generated/microflow_firmata_wasm.js";
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
  silentDevice,
} from "./link-fakes";
import type { BoardState } from "@/lib/bindings/BoardState";
import type { BringUpAction } from "./wasm";

initSync({
  module: readFileSync(new URL("./generated/microflow_firmata_wasm_bg.wasm", import.meta.url)),
});

type FakeReactor = ReactorHandle & {
  connection: BoardConnection | null;
  fed: number[];
  disposed: boolean;
  fault: (message: string) => void;
};

/** What the port's USB id says: `identified` is an official Arduino board,
 *  `guessed` includes a generic USB-serial chip's suggestion. */
type UsbIdentity = { identified?: string; guessed?: string };

function linked(usb: UsbIdentity = { identified: "uno", guessed: "uno" }) {
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
  let flashes = 0;
  const flashedBoards: Array<string | undefined> = [];

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
      detectBoard: async () => usb.identified,
      guessBoard: async () => usb.guessed,
      probeFirmata: (p, hooks) => probeBoard(env, p, hooks, { afterFlash: false }),
      probeAfterFlash: (p, hooks) => probeBoard(env, p, hooks, { afterFlash: true }),
      flashPort: async (_port, opts) => {
        flashes += 1;
        flashedBoards.push(opts?.board);
        return opts?.board ?? "uno";
      },
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
    createMachine: async () => new BringUpMachine(),
    handleEvent: (machine, event) =>
      JSON.parse(machine.handle(JSON.stringify(event))) as BringUpAction[],
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
        applyFlow: () => ({ ok: true }),
        feedBytes(bytes) {
          reactor.fed.push(...bytes);
        },
        dispatchToNode() {},
        keyEvent() {},
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
    get flashes() {
      return flashes;
    },
    flashedBoards,
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

  test("a disconnect event while the reader is still open closes the port without a retry", async () => {
    // The `portGone` path on its own: the event wins the race with the reader.
    const h = linked();
    await h.connected();

    h.serial.fire("disconnect", h.port);
    await h.settle();

    expect(h.last()).toBe("disconnected");
    expect(h.port.isOpen).toBe(false);
    expect(h.controller.retrying).toBe(false);
  });

  test("a real unplug — reader error, then the disconnect event — closes the port; a replug reconnects", async () => {
    const h = linked();
    await h.connected();

    // What Chromium does: the pending read rejects first, the device leaves
    // the granted list, and `disconnect` follows.
    h.port.unplug();
    h.serial.granted = [];
    h.serial.fire("disconnect", h.port);
    await h.settle();

    expect(h.last()).toBe("disconnected");
    expect(h.port.isOpen).toBe(false);
    // The rescans find nothing and the backoff runs out.
    await h.clock.until(() => !h.controller.retrying);
    expect(h.port.isOpen).toBe(false);

    h.serial.granted = [h.port];
    h.serial.fire("connect", h.port);
    await h.clock.until(() => h.last() === "connected");
    await h.settle();
    expect(h.port.isOpen).toBe(true);
    expect(h.flashes).toBe(0);
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
    expect(Array.from(h.port.written.at(-1) ?? [])).toContain(FIRMATA_SYSTEM_RESET);
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
    expect(Array.from(h.port.written.at(-1) ?? [])).toContain(FIRMATA_SYSTEM_RESET);
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

describe("an explicit connect overtaken by pagehide or an engine fault", () => {
  /** A controller with nothing granted, so only the gesture connects. */
  function gestureOnly(device = firmataDevice()) {
    const h = linked();
    h.port.device = device;
    h.serial.granted = [];
    h.serial.picked = h.port;
    h.controller.start();
    return h;
  }

  test("control: the real machine flashes a known board that does not answer", async () => {
    const h = gestureOnly(silentDevice());
    await h.clock.run(h.controller.connect());
    await h.settle();

    expect(h.flashes).toBe(1);
    expect(h.toasts.at(-1)).toContain("did not come back up");
  });

  test("a probe that answers after pagehide gives the port back, without flashing", async () => {
    const h = gestureOnly();
    const connecting = h.controller.connect();
    await h.clock.until(() => h.port.isOpen);

    h.lifecycle().onPageHide();
    await h.clock.run(connecting);
    await h.settle();

    expect(h.flashes).toBe(0);
    expect(h.port.isOpen).toBe(false);
    expect(h.last()).toBe("disconnected");
    expect(h.toasts).toEqual([]);
  });

  test("a probe that misses after pagehide does not flash either", async () => {
    const h = gestureOnly(silentDevice());
    const connecting = h.controller.connect();
    await h.clock.until(() => h.port.isOpen);

    h.lifecycle().onPageHide();
    await h.clock.run(connecting);
    await h.settle();

    expect(h.flashes).toBe(0);
    expect(h.port.isOpen).toBe(false);
    expect(h.last()).toBe("disconnected");
    expect(h.toasts).toEqual([]);
  });

  test("an engine fault during the probe: no flash, no false toast, the fault stays", async () => {
    const h = gestureOnly();
    const connecting = h.controller.connect();
    await h.clock.until(() => h.port.isOpen);

    const fault = "The flow engine stopped: unreachable";
    h.reactors.find((r) => r.connection === null)!.fault(fault);
    await h.clock.run(connecting);
    await h.settle();

    expect(h.flashes).toBe(0);
    expect(h.port.isOpen).toBe(false);
    expect(h.states.at(-1)).toEqual({ state: "error", error: fault });
    expect(h.toasts).toEqual([fault]);
  });
});

describe("auto-flash needs a positively identified board", () => {
  /** A gesture connect to a device with no Firmata, identified as `usb` says. */
  async function gestureToSilent(usb: UsbIdentity) {
    const h = linked(usb);
    h.port.device = silentDevice();
    h.serial.granted = [];
    h.serial.picked = h.port;
    h.controller.start();
    await h.clock.run(h.controller.connect());
    await h.settle();
    return h;
  }

  test("an official Arduino without Firmata is flashed unasked", async () => {
    const h = await gestureToSilent({ identified: "uno", guessed: "uno" });

    expect(h.flashedBoards).toEqual(["uno"]);
    expect(h.states.some((s) => s.state === "confirmFlash")).toBe(false);
  });

  /** The open offer as the store shows it (what the prompt answers with). */
  function openOffer(h: ReturnType<typeof linked>) {
    const state = h.states.at(-1);
    if (state?.state !== "confirmFlash") throw new Error(`no open offer: ${state?.state}`);
    return state;
  }

  test("a CH340 device is offered, and flashed only once the user confirms", async () => {
    const h = await gestureToSilent({ guessed: "nano" });

    expect(h.flashes).toBe(0);
    expect(h.states.at(-1)).toEqual({
      state: "confirmFlash",
      port: "USB 2341:0043",
      board: "nano",
      vid: 0x2341,
      pid: 0x0043,
    });
    expect(h.port.isOpen).toBe(false);

    // The flash puts Firmata on the board.
    h.port.device = firmataDevice();
    await h.clock.run(h.controller.confirmFlash(openOffer(h)));
    await h.settle();

    expect(h.flashedBoards).toEqual(["nano"]);
    expect(h.last()).toBe("connected");
  });

  test("declining the offer flashes nothing, and a late yes is ignored", async () => {
    const h = await gestureToSilent({ guessed: "nano" });
    const offer = openOffer(h);

    await h.clock.run(h.controller.declineFlash(offer));
    await h.settle();
    expect(h.last()).toBe("disconnected");

    await h.clock.run(h.controller.confirmFlash(offer));
    await h.settle();
    expect(h.flashes).toBe(0);
  });

  test("unplugging the offered device withdraws the offer; a late yes flashes nothing", async () => {
    // Review finding 5: the toast stayed and a click gave "Flash failed".
    const h = await gestureToSilent({ guessed: "nano" });
    const offer = openOffer(h);

    h.serial.fire("disconnect", h.port);
    await h.settle();
    expect(h.last()).toBe("disconnected");

    await h.clock.run(h.controller.confirmFlash(offer));
    await h.settle();
    expect(h.flashes).toBe(0);
    expect(h.toasts).toEqual([]);
  });

  test("another granted device plugging in does not withdraw the offer", async () => {
    const h = await gestureToSilent({ guessed: "nano" });
    const other = new FakeSerialPort();
    h.serial.granted = [other];
    h.serial.fire("connect", other);
    await h.settle();

    expect(other.opens).toBe(0);
    expect(h.last()).toBe("confirmFlash");

    h.port.device = firmataDevice();
    await h.clock.run(h.controller.confirmFlash(openOffer(h)));
    await h.settle();
    expect(h.flashedBoards).toEqual(["nano"]);
  });

  test("an answer naming a different device is ignored", async () => {
    const h = await gestureToSilent({ guessed: "nano" });
    const offer = openOffer(h);

    await h.clock.run(h.controller.confirmFlash({ ...offer, pid: 0x7523 }));
    await h.settle();
    expect(h.flashes).toBe(0);
    expect(h.last()).toBe("confirmFlash");
  });

  test("an unknown device is never flashed or offered", async () => {
    const h = await gestureToSilent({});

    expect(h.flashes).toBe(0);
    expect(h.states.some((s) => s.state === "confirmFlash")).toBe(false);
    expect(h.last()).toBe("error");
  });

  test("a granted CH340 with Firmata reconnects on load without any offer", async () => {
    const h = linked({ guessed: "nano" });
    await h.connected();

    expect(h.flashes).toBe(0);
    expect(h.states.some((s) => s.state === "confirmFlash")).toBe(false);
  });
});
