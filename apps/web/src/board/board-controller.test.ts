import { describe, expect, test } from "bun:test";
// The core module deliberately imports nothing at runtime, so this test needs
// no env, no stores, no wasm and no browser.
import {
  BoardController,
  type BoardControllerDeps,
  type ReactorHandle,
} from "./board-controller-core";
import type { BoardState } from "@/lib/bindings/BoardState";
import type { BringUpAction, BringUpEvent } from "./wasm";

// A fake port. Only `getInfo` is ever read by the controller itself.
function fakePort(label = "usb1") {
  return { getInfo: () => ({ usbVendorId: 1, usbProductId: 2, label }) } as never;
}

function fakeConnection(port: unknown) {
  return {
    port,
    session: {},
    write: async () => {},
    disconnect: async () => {},
  } as never;
}

function fakeReactor(): ReactorHandle & { disposed: boolean; flows: unknown[] } {
  const reactor = {
    disposed: false,
    flows: [] as unknown[],
    applyFlow(flow: unknown) {
      reactor.flows.push(flow);
    },
    feedBytes() {},
    dispatchToNode() {},
    dispose() {
      reactor.disposed = true;
    },
  };
  return reactor as ReactorHandle & { disposed: boolean; flows: unknown[] };
}

type Harness = {
  deps: BoardControllerDeps;
  /** Scripted machine: each event maps to the actions the machine would return. */
  script: (respond: (event: BringUpEvent) => BringUpAction[]) => void;
  events: BringUpEvent[];
  boardStates: BoardState[];
  toasts: string[];
  tracked: Array<{ event: string; data?: Record<string, unknown> }>;
  reactors: Array<ReturnType<typeof fakeReactor>>;
  grantedPorts: unknown[];
  probeResult: () => unknown;
  /** Fire the engine fault the most recently attached reactor would report. */
  faultEngine: (message: string) => void;
};

function harness(overrides: Partial<BoardControllerDeps["serial"]> = {}): Harness {
  const events: BringUpEvent[] = [];
  const boardStates: BoardState[] = [];
  const toasts: string[] = [];
  const tracked: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const reactors: Array<ReturnType<typeof fakeReactor>> = [];
  const state = {
    grantedPorts: [] as unknown[],
    probeResult: (() => fakeConnection(fakePort())) as () => unknown,
    respond: (_event: BringUpEvent): BringUpAction[] => [],
    faultLatest: undefined as ((message: string) => void) | undefined,
  };

  const deps: BoardControllerDeps = {
    serial: {
      isSupported: () => true,
      listGrantedPorts: (async () => state.grantedPorts) as never,
      requestBoardPort: (async () => fakePort()) as never,
      detectBoard: (async () => "Arduino Uno") as never,
      probeFirmata: (async () => state.probeResult()) as never,
      probeAfterFlash: (async () => state.probeResult()) as never,
      flashPort: (async () => "ok") as never,
      onConnectivity: (() => {}) as never,
      portLabel: (() => "COM1") as never,
      connectedState: (() => ({ state: "connected" }) as BoardState) as never,
      ...overrides,
    },
    createMachine: async () => ({}) as never,
    handleEvent: (_machine, event) => {
      events.push(event);
      return state.respond(event);
    },
    attachReactor: async (_connection, hooks) => {
      const reactor = fakeReactor();
      reactors.push(reactor);
      state.faultLatest = hooks.onEngineFault;
      return reactor;
    },
    setBoard: (s) => boardStates.push(s),
    notify: {
      loading: (m) => {
        toasts.push(`loading:${m}`);
        return 1;
      },
      success: (m) => void toasts.push(`success:${m}`),
      error: (m) => void toasts.push(`error:${m}`),
      dismiss: () => void toasts.push("dismiss"),
    },
    track: ((event: string, data?: Record<string, unknown>) => {
      tracked.push({ event, data });
    }) as never,
    isDesktop: () => false,
  };

  return {
    deps,
    script: (respond) => {
      state.respond = respond;
    },
    events,
    boardStates,
    toasts,
    tracked,
    reactors,
    get grantedPorts() {
      return state.grantedPorts;
    },
    set grantedPorts(ports: unknown[]) {
      state.grantedPorts = ports;
    },
    get probeResult() {
      return state.probeResult;
    },
    set probeResult(fn: () => unknown) {
      state.probeResult = fn;
    },
    faultEngine: (message: string) => state.faultLatest?.(message),
  } as Harness;
}

describe("bring-up sequence", () => {
  test("a successful gesture connect probes, then attaches a reactor", async () => {
    const h = harness();
    h.script((event) => {
      if (event.type === "portReady") return [{ type: "probe", afterFlash: false } as BringUpAction];
      if (event.type === "probeOk")
        return [{ type: "notify", phase: { kind: "connected" } } as BringUpAction];
      return [];
    });
    const controller = new BoardController(h.deps);

    await controller.connect();
    await controller.settled();

    expect(h.events.map((e) => e.type)).toEqual(["portReady", "probeOk"]);
    expect(h.boardStates.at(-1)).toEqual({ state: "connected" });
    // Boardless reactor is never stood up here; the connected one is.
    expect(h.reactors).toHaveLength(1);
    expect(h.tracked.map((t) => t.event)).toContain("board_connected");
  });

  test("a failed probe reports probeFailed, not probeOk", async () => {
    const h = harness();
    h.probeResult = () => null;
    h.script((event) =>
      event.type === "portReady" ? [{ type: "probe", afterFlash: false } as BringUpAction] : [],
    );
    const controller = new BoardController(h.deps);

    await controller.connect();
    await controller.settled();

    expect(h.events.map((e) => e.type)).toEqual(["portReady", "probeFailed"]);
  });

  test("a dismissed picker settles as disconnected rather than an error", async () => {
    const h = harness({ requestBoardPort: (() => Promise.reject(new Error("dismissed"))) as never });
    const controller = new BoardController(h.deps);

    await controller.connect();
    await controller.settled();

    expect(h.boardStates).toEqual([{ state: "disconnected" }]);
    expect(h.events).toEqual([]);
  });

  test("an unsupported host does nothing at all", async () => {
    const h = harness({ isSupported: () => false });
    const controller = new BoardController(h.deps);

    await controller.connect();
    await controller.settled();

    expect(h.boardStates).toEqual([]);
    expect(h.events).toEqual([]);
  });
});

describe("port operations are serialised", () => {
  test("a second connect cannot start a bring-up while the first holds the board", async () => {
    // The invariant the queue exists for: two overlapping bring-ups would open
    // the same port twice.
    const h = harness();
    h.script((event) => {
      if (event.type === "portReady") return [{ type: "probe", afterFlash: false } as BringUpAction];
      if (event.type === "probeOk")
        return [{ type: "notify", phase: { kind: "connected" } } as BringUpAction];
      return [];
    });
    const controller = new BoardController(h.deps);

    await Promise.all([controller.connect(), controller.connect()]);
    await controller.settled();

    // The second call found `active` already set and stood down.
    expect(h.events.filter((e) => e.type === "portReady")).toHaveLength(1);
  });
});

describe("engine fault", () => {
  test("disposes the reactor and latches so it is never respawned", async () => {
    // ADR-0017: a trapped wasm module cannot be revived, and a fresh one would
    // just re-run the flow that trapped it.
    const h = harness();
    const controller = new BoardController(h.deps);

    controller.start();
    await controller.settled();
    expect(h.reactors).toHaveLength(1);

    h.faultEngine("unreachable executed");

    expect(h.reactors[0].disposed).toBe(true);
    expect(h.boardStates.at(-1)).toEqual({ state: "error", error: "unreachable executed" });
    expect(h.toasts).toContain("error:unreachable executed");

    // A later flow push must not stand a new runtime back up.
    controller.pushFlowUpdate({ nodes: [], edges: [] } as never);
    await controller.settled();
    expect(h.reactors).toHaveLength(1);
  });
});

describe("flow updates", () => {
  test("a flow pushed before any board is applied once one attaches", async () => {
    const h = harness();
    h.script((event) => {
      if (event.type === "portReady") return [{ type: "probe", afterFlash: false } as BringUpAction];
      if (event.type === "probeOk")
        return [{ type: "notify", phase: { kind: "connected" } } as BringUpAction];
      return [];
    });
    const controller = new BoardController(h.deps);

    const flow = { nodes: [], edges: [] } as never;
    controller.pushFlowUpdate(flow);

    await controller.connect();
    await controller.settled();

    expect(h.reactors.at(-1)?.flows).toEqual([flow]);
  });
});
