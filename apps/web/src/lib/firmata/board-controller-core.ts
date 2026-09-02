// The browser bring-up controller: the sequencing around the shared bring-up
// machine, with every piece of I/O taken as a constructor argument.
//
// The bring-up POLICY — probe → flash StandardFirmata if missing → connect →
// auto-reconnect, plus the disconnected→connecting→flashing→connected→error
// transitions — lives once in the sans-IO `microflow_core::bringup` state
// machine (via the firmata wasm crate); both hosts drive the same machine.
//
// What is left here is not policy but *sequencing*, and it has invariants worth
// testing: one serialised queue so no two port operations overlap, the in-flight
// attempt's bookkeeping, and the latched engine fault that must never respawn a
// runtime into the same trap (ADR-0017).
//
// Every import below is type-only, so this module pulls in no store, no toast
// library and no wasm. `board-controller.ts` is the composition root that binds
// the real ones; a test binds fakes and drives the whole
// dispatch → perform → applyPhase sequence without a browser.

import type * as WebSerial from "./web-serial";
import type * as Analytics from "@/lib/analytics";
import type { BoardConnection, ProbeHooks, WebSerialPort } from "./web-serial";
import type {
  BringUpAction,
  BringUpEvent,
  BringUpMachine,
  BringUpPhase,
} from "./wasm";
import type { BoardState } from "@/lib/bindings/BoardState";
import type { FlowUpdate as CoreFlowUpdate } from "@/lib/bindings/FlowUpdate";

/** The part of a `FlowReactor` this module drives. Named so a test can stand in
 *  for it without a wasm module. */
export interface ReactorHandle {
  applyFlow(flow: CoreFlowUpdate): void;
  feedBytes(bytes: Uint8Array): void;
  dispatchToNode(nodeId: string, port: string, value: unknown): void;
  dispose(): void;
}

/** The toast surface, narrowed to what bring-up uses. */
export interface Notifier {
  loading(message: string, options?: { id?: string | number }): string | number;
  success(message: string, options?: { id?: string | number }): void;
  error(message: string): void;
  dismiss(id: string | number): void;
}

/**
 * Every piece of I/O the controller performs, as one injectable surface.
 *
 * The serial members take their types from the real `web-serial` functions, so
 * this declaration cannot drift from what it stands in for — and a fake is
 * type-checked against the same shape the production adapter satisfies.
 */
export interface BoardControllerDeps {
  serial: {
    isSupported: typeof WebSerial.isWebSerialSupported;
    listGrantedPorts: typeof WebSerial.listGrantedPorts;
    requestBoardPort: typeof WebSerial.requestBoardPort;
    detectBoard: typeof WebSerial.detectBoard;
    probeFirmata: typeof WebSerial.probeFirmata;
    probeAfterFlash: typeof WebSerial.probeAfterFlash;
    flashPort: typeof WebSerial.flashPort;
    onConnectivity: typeof WebSerial.onSerialConnectivity;
    portLabel: typeof WebSerial.portLabel;
    connectedState: typeof WebSerial.connectedState;
  };
  createMachine(): Promise<BringUpMachine>;
  handleEvent(machine: BringUpMachine, event: BringUpEvent): BringUpAction[];
  attachReactor(
    connection: BoardConnection | null,
    hooks: { onEngineFault: (message: string) => void },
  ): Promise<ReactorHandle>;
  setBoard(state: BoardState): void;
  notify: Notifier;
  track: typeof Analytics.track;
  /** The desktop host runs its own bring-up; this controller stands down there. */
  isDesktop(): boolean;
}

/** Host-side bookkeeping for the bring-up attempt in flight (toast ids,
 *  analytics facts) — presentation only; the machine owns the decisions. */
type Attempt = {
  port: WebSerialPort;
  explicit: boolean;
  startedAt: number;
  board: string;
  flashed: boolean;
  flashToast?: string | number;
};

export class BoardController {
  /** The single active browser board connection — the adapter's I/O handle;
   *  every DECISION about it comes from the shared bring-up machine. */
  private active: BoardConnection | null = null;
  /** The wasm flow-runtime host for the active connection. */
  private reactor: ReactorHandle | null = null;
  /** Latest core `FlowUpdate`, applied when a board attaches. */
  private latestFlow: CoreFlowUpdate | null = null;
  /** The shared bring-up policy machine (lazy: wasm loads on first use). */
  private machinePromise: Promise<BringUpMachine> | null = null;
  private started = false;
  // A trapped wasm module never runs a flow again (ADR-0017); latched so the
  // boardless runtime is not respawned into the same fault on every disconnect.
  private engineDead = false;
  // Serialise every port operation so connect / auto-reconnect / plug events
  // never race to open the same port.
  private queue: Promise<unknown> = Promise.resolve();
  private attempt: Attempt | null = null;

  constructor(private readonly deps: BoardControllerDeps) {}

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    // Keep the chain alive regardless of individual task outcome.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Resolve once every queued port operation has settled. Tests only — the app
   *  never waits on the queue, it just adds to it. */
  async settled(): Promise<void> {
    await this.queue;
  }

  /**
   * Push the latest flow graph to the runtime. Called by `WasmFlowUpdateSender`
   * on every graph change; stored so a board connecting later starts on the
   * current flow.
   */
  pushFlowUpdate(flow: CoreFlowUpdate): void {
    this.latestFlow = flow;
    this.reactor?.applyFlow(flow);
  }

  /**
   * Deliver one host-originated input (today: a hotkey key event) to a node's
   * port. A no-op only while the runtime is down (an engine fault).
   */
  dispatchToNode(nodeId: string, port: string, value: unknown): void {
    this.reactor?.dispatchToNode(nodeId, port, value);
  }

  /**
   * Stand up a runtime with no board behind it, so the software half of a flow
   * (Hotkey, Interval, Llm, Mqtt, Midi, …) runs from page load instead of
   * waiting for hardware that may never arrive. Replaced by a board-backed
   * runtime when one connects, and restored when it goes away.
   *
   * Never revives a runtime killed by an engine fault: that module is trapped,
   * and a fresh one would just re-run the flow that trapped it (ADR-0017).
   */
  private ensureBoardlessReactor(): void {
    if (this.deps.isDesktop() || this.engineDead || this.reactor !== null) return;
    void this.run(async () => {
      // `run` serialises against bring-up, so a board may have won the race.
      if (this.reactor !== null || this.active !== null || this.engineDead) return;
      try {
        this.reactor = await this.deps.attachReactor(null, {
          onEngineFault: (m) => this.onEngineFault(m),
        });
        if (this.latestFlow) this.reactor.applyFlow(this.latestFlow);
      } catch (error) {
        console.error("[board-controller] boardless reactor attach failed:", error);
        this.reactor = null;
      }
    });
  }

  private trackData(a: Attempt) {
    return {
      via: a.explicit ? "gesture" : "auto",
      board: a.board,
      flashed: a.flashed,
      seconds: Math.round((performance.now() - a.startedAt) / 1000),
    };
  }

  /** Feed one event into the shared machine and perform the returned actions. */
  private async dispatch(event: BringUpEvent): Promise<void> {
    this.machinePromise ??= this.deps.createMachine();
    const machine = await this.machinePromise;
    const actions = this.deps.handleEvent(machine, event);
    for (const action of actions) {
      await this.perform(action);
    }
  }

  /**
   * The wasm flow engine died — a Rust panic traps the module, so no flow will
   * run again on this runtime (ADR-0017). Drop the reactor so nothing calls back
   * into the dead module, and surface it on the board-level error state.
   *
   * Deliberately NOT a bring-up event: the port is open and the board is fine,
   * so `connectionLost` would be a lie, and the machine's retry would close a
   * working port to reconnect into the same dead module, forever. This sets the
   * store directly instead — a *notify* without a transition.
   *
   * It uses the `error` state rather than a toast alone because the condition is
   * persistent and a toast is not: until the page reloads, this board runs no
   * flow, and a UI still reading `connected` would say otherwise. Reload is the
   * recovery (a trapped module cannot be revived in place), which is also why it
   * does not matter that `connect()` short-circuits while `active` is set.
   */
  private onEngineFault(message: string): void {
    this.engineDead = true;
    this.reactor?.dispose();
    this.reactor = null;
    console.error("[board-controller] flow engine fault:", message);
    this.deps.setBoard({ state: "error", error: message });
    this.deps.notify.error(message);
  }

  /** The probe hooks: raw bytes feed the flow runtime; an unexpected read-loop
   *  end while connected re-enters the machine as `connectionLost`. */
  private probeHooks(): ProbeHooks {
    return {
      // Only once a connection is live: mid-bring-up the reactor is still the
      // boardless one, whose empty pin table cannot decode this board's traffic.
      onBytes: (bytes) => {
        if (this.active) this.reactor?.feedBytes(bytes);
      },
      onClosed: () => void this.run(() => this.dispatch({ type: "connectionLost" })),
    };
  }

  private async perform(action: BringUpAction): Promise<void> {
    switch (action.type) {
      case "probe": {
        const a = this.attempt;
        if (!a) return;
        const probe = action.afterFlash ? this.deps.serial.probeAfterFlash : this.deps.serial.probeFirmata;
        const connection = await probe(a.port, this.probeHooks()).catch(() => null);
        if (connection) {
          this.active = connection;
          await this.dispatch({ type: "probeOk" });
        } else {
          await this.dispatch({ type: "probeFailed" });
        }
        break;
      }
      case "flash": {
        const a = this.attempt;
        if (!a) return;
        try {
          await this.deps.serial.flashPort(a.port, {
            onProgress: (done, total) => void this.dispatch({ type: "flashProgress", done, total }),
          });
          await this.dispatch({ type: "flashOk" });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await this.dispatch({ type: "flashFailed", detail });
        }
        break;
      }
      case "closePort": {
        this.reactor?.dispose();
        this.reactor = null;
        const connection = this.active;
        this.active = null;
        await connection?.disconnect();
        // The board is gone, the flow is not: fall back to the boardless runtime.
        this.ensureBoardlessReactor();
        break;
      }
      case "scheduleRetry":
        // A reset keeps the USB device present (no `connect` event fires), so
        // rescanning granted ports re-detects it — the browser's retry primitive.
        void this.run(() => this.reconnectGranted());
        break;
      case "notifyFlashProgress": {
        if (this.attempt?.flashToast !== undefined) {
          this.attempt.flashToast = this.deps.notify.loading(
            `Flashing StandardFirmata… ${action.percent}%`,
            { id: this.attempt.flashToast },
          );
        }
        break;
      }
      case "notify":
        await this.applyPhase(action.phase);
        break;
    }
  }

  /** Map a machine phase onto the board store + toasts (presentation only). */
  private async applyPhase(phase: BringUpPhase): Promise<void> {
    const a = this.attempt;
    switch (phase.kind) {
      case "connecting":
        this.deps.setBoard({ state: "connecting" });
        break;
      case "flashing": {
        if (a) {
          a.flashed = true;
          a.board = phase.board;
          a.flashToast ??= this.deps.notify.loading("Flashing StandardFirmata…");
        }
        this.deps.setBoard({
          state: "flashing",
          port: a ? this.deps.serial.portLabel(a.port.getInfo()) : "Serial port",
          board: phase.board,
        });
        break;
      }
      case "connected": {
        if (this.active)
          this.deps.setBoard(this.deps.serial.connectedState(this.active.port, this.active.session));
        if (a?.flashToast !== undefined) {
          this.deps.notify.success(`Flashed StandardFirmata to ${a.board}.`, { id: a.flashToast });
          a.flashToast = undefined;
        }
        // Stand up the wasm flow runtime for this connection and apply the
        // current flow. A reactor failure (e.g. wasm load) must not fail the
        // connection — the board is still up; the flow just won't run.
        this.reactor?.dispose();
        this.reactor = null;
        if (this.active) {
          try {
            this.reactor = await this.deps.attachReactor(this.active, {
              onEngineFault: (m) => this.onEngineFault(m),
            });
            if (this.latestFlow) this.reactor.applyFlow(this.latestFlow);
          } catch (reactorError) {
            console.error("[board-controller] flow reactor attach failed:", reactorError);
            this.reactor = null;
          }
        }
        if (a) {
          this.deps.track("board_connected", this.trackData(a));
          this.attempt = null;
        }
        break;
      }
      case "disconnected":
        if (a?.flashToast !== undefined) {
          this.deps.notify.dismiss(a.flashToast);
          a.flashToast = undefined;
        }
        if (a) {
          // A bring-up attempt ended quietly (background probe miss).
          this.deps.track("board_connect_failed", { ...this.trackData(a), error: "no firmata" });
          this.attempt = null;
        }
        this.deps.setBoard({ state: "disconnected" });
        break;
      case "error":
        if (a?.flashToast !== undefined) {
          this.deps.notify.dismiss(a.flashToast);
          a.flashToast = undefined;
        }
        if (a) {
          this.deps.track("board_connect_failed", {
            ...this.trackData(a),
            error: phase.detail.slice(0, 80),
          });
          this.attempt = null;
        }
        // Full detail reaches the store + toast (do not collapse it — 7c8f7e2).
        this.deps.setBoard({ state: "error", error: phase.detail });
        this.deps.notify.error(phase.detail);
        break;
    }
  }

  /** Start a bring-up attempt for `port`; the machine takes it from here. */
  private async bringUp(
    port: WebSerialPort,
    flags: { autoFlash: boolean; explicit: boolean },
  ): Promise<void> {
    const board = await this.deps.serial.detectBoard(port).catch(() => undefined);
    this.attempt = {
      port,
      explicit: flags.explicit,
      startedAt: performance.now(),
      board: board ?? "unknown",
      flashed: false,
    };
    await this.dispatch({
      type: "portReady",
      board: board ?? null,
      autoFlash: flags.autoFlash,
      explicit: flags.explicit,
    });
  }

  /** Cheap pre-check so auto paths don't handshake unrelated granted serial devices. */
  private async looksLikeBoard(port: WebSerialPort): Promise<boolean> {
    try {
      return Boolean(await this.deps.serial.detectBoard(port));
    } catch {
      return false;
    }
  }

  /**
   * Connect from a user gesture: pick a port, then let the machine run probe →
   * flash-if-missing → connect. `requestPort` must fire synchronously inside the
   * gesture, so it runs *before* the serialised task — only the bring-up is queued.
   */
  connect(): Promise<void> {
    if (!this.deps.serial.isSupported()) return Promise.resolve();
    // requestPort MUST run inside the user gesture — fire it now, before queueing.
    // Wrap so a dismissed picker never surfaces as an unhandled rejection while the
    // bring-up waits its turn behind the load scan.
    const picked = this.deps.serial.requestBoardPort().then(
      (port): { port: WebSerialPort | null } => ({ port }),
      (): { port: WebSerialPort | null } => ({ port: null }),
    );
    return this.run(async () => {
      const { port } = await picked;
      if (!port) {
        // Picker dismissed — not an error.
        if (!this.active) this.deps.setBoard({ state: "disconnected" });
        return;
      }
      if (this.active) return; // auto-reconnect won the race
      await this.bringUp(port, { autoFlash: true, explicit: true });
    });
  }

  disconnect(): Promise<void> {
    this.deps.track("board_disconnected", { via: "gesture" });
    return this.run(() => this.dispatch({ type: "disconnectRequested" }));
  }

  /**
   * Reconnect a granted board — recognised boards only, so we never hang
   * handshaking an unrelated serial device the user once authorised. Shared by the
   * load scan and the reset-recovery path.
   */
  private async reconnectGranted(): Promise<void> {
    if (this.active) return;
    for (const port of await this.deps.serial.listGrantedPorts()) {
      if (this.active) break;
      if (!(await this.looksLikeBoard(port))) continue;
      await this.bringUp(port, { autoFlash: false, explicit: false });
    }
  }

  /**
   * Start the background orchestration once: stand up the boardless flow runtime,
   * reconnect any already-granted board on load, and watch for plug/unplug of
   * granted devices. Idempotent.
   *
   * Only the board half needs Chromium — the runtime runs in every browser, so a
   * Firefox user still gets their software nodes.
   */
  start(): void {
    if (this.started || this.deps.isDesktop()) return;
    this.started = true;

    this.ensureBoardlessReactor();

    if (!this.deps.serial.isSupported()) return;

    // Reconnect a granted board on load (no picker; common case: a board that
    // already has Firmata just comes back).
    void this.run(() => this.reconnectGranted());

    this.deps.serial.onConnectivity({
      onConnect: (port) =>
        void this.run(async () => {
          if (this.active) return;
          if (!(await this.looksLikeBoard(port))) return;
          await this.bringUp(port, { autoFlash: false, explicit: false });
        }),
      onDisconnect: (port) =>
        void this.run(async () => {
          if (this.active && this.active.port === port) {
            await this.dispatch({ type: "portGone" });
          }
        }),
    });
  }
}
