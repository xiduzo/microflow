// The browser bring-up controller: the sequencing around the shared bring-up
// machine, with every piece of I/O taken as a constructor argument.
//
// The bring-up POLICY — probe → flash StandardFirmata if missing → connect →
// auto-reconnect, plus the disconnected→connecting→flashing→connected→error
// transitions — lives once in the sans-IO `microflow_core::bringup` state
// machine (via the firmata wasm crate); both hosts drive the same machine.
//
// What is left here is the host's half, and it is the one owner of the browser
// board connection:
//
// - the live link (`board-link.ts`) — at most one, replaced only through the
//   machine's `closePort`, and its inbound stream handed to the flow runtime
//   only once that runtime exists;
// - the board store, written through `publish`, so a latched engine fault can
//   never be painted over by a later phase.
//
// Every import below is type-only, so this module pulls in no store, no toast
// library and no wasm. `board-controller.ts` is the composition root that binds
// the real ones; a test binds fakes and drives the whole
// dispatch → perform → applyPhase sequence without a browser.

import type * as WebSerial from "./web-serial";
import type * as Analytics from "@/lib/analytics";
import type { BoardConnection, LinkLoss, ProbeHooks } from "./board-link";
import type { Clock } from "./clock";
import type { WebSerialPort } from "./serial-port";
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
  clock: Clock;
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
  /** The single live board link. Every DECISION about it comes from the shared
   *  bring-up machine; its transport lifecycle is the link's own. */
  private link: BoardConnection | null = null;
  /** The wasm flow-runtime host — board-backed while a link is attached,
   *  boardless otherwise. */
  private reactor: ReactorHandle | null = null;
  /** Latest core `FlowUpdate`, applied when a board attaches. */
  private latestFlow: CoreFlowUpdate | null = null;
  /** The shared bring-up policy machine (lazy: wasm loads on first use). */
  private machinePromise: Promise<BringUpMachine> | null = null;
  private started = false;
  /** Set once the wasm engine traps (ADR-0017). Terminal until reload: no
   *  runtime is respawned, no board is brought up, the store stays `error`. */
  private engineFault: string | null = null;
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
    let seen: Promise<unknown> | null = null;
    // A task may queue another (a lost link queues `connectionLost`); wait the
    // chain out rather than the snapshot taken on entry.
    while (seen !== this.queue) {
      seen = this.queue;
      await seen;
    }
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

  /** The one writer of the board store: a latched engine fault outranks every
   *  phase the machine reports after it. */
  private publish(state: BoardState): void {
    this.deps.setBoard(
      this.engineFault === null ? state : { state: "error", error: this.engineFault },
    );
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
    if (this.deps.isDesktop() || this.engineFault !== null || this.reactor !== null) return;
    void this.run(async () => {
      // `run` serialises against bring-up, so a board may have won the race.
      if (this.reactor !== null || this.link !== null || this.engineFault !== null) return;
      try {
        const reactor = await this.deps.attachReactor(null, {
          onEngineFault: (m) => this.onEngineFault(m),
        });
        if (this.engineFault !== null) {
          reactor.dispose();
          return;
        }
        this.reactor = reactor;
        if (this.latestFlow) reactor.applyFlow(this.latestFlow);
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
      seconds: Math.round((this.deps.clock.now() - a.startedAt) / 1000),
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
   * Deliberately NOT a bring-up event: `connectionLost` would retry into the
   * same dead module, forever (ADR-0017 D3). `publish` keeps `error` showing
   * over any later phase; reload is the recovery.
   */
  private onEngineFault(message: string): void {
    if (this.engineFault !== null) return;
    this.engineFault = message;
    this.reactor?.dispose();
    this.reactor = null;
    console.error("[board-controller] flow engine fault:", message);
    this.publish({ state: "error", error: message });
    this.deps.notify.error(message);
  }

  /** The link's hooks: a live link losing its transport re-enters the machine
   *  as `connectionLost`, which closes the port and schedules the retry. */
  private linkHooks(): ProbeHooks {
    return {
      onLost: (link: BoardConnection, loss: LinkLoss) => {
        console.warn(
          `[board-controller] board link lost (${loss.cause})`,
          loss.cause === "writeFailed" ? String(loss.error) : "",
        );
        void this.run(async () => {
          // A link that was already replaced or closed must not tear down its
          // successor.
          if (this.link !== link) return;
          await this.dispatch({ type: "connectionLost" });
        });
      },
    };
  }

  private async perform(action: BringUpAction): Promise<void> {
    switch (action.type) {
      case "probe": {
        const a = this.attempt;
        if (!a) return;
        const probe = action.afterFlash ? this.deps.serial.probeAfterFlash : this.deps.serial.probeFirmata;
        const connection = await probe(a.port, this.linkHooks()).catch(() => null);
        if (connection) {
          this.link = connection;
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
        const link = this.link;
        this.link = null;
        await link?.disconnect();
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
        this.publish({ state: "connecting" });
        break;
      case "flashing": {
        if (a) {
          a.flashed = true;
          a.board = phase.board;
          a.flashToast ??= this.deps.notify.loading("Flashing StandardFirmata…");
        }
        this.publish({
          state: "flashing",
          port: a ? this.deps.serial.portLabel(a.port.getInfo()) : "Serial port",
          board: phase.board,
        });
        break;
      }
      case "connected": {
        const link = this.link;
        if (link) this.publish(this.deps.serial.connectedState(link.port, link.session));
        if (a?.flashToast !== undefined) {
          this.deps.notify.success(`Flashed StandardFirmata to ${a.board}.`, { id: a.flashToast });
          a.flashToast = undefined;
        }
        this.reactor?.dispose();
        this.reactor = null;
        if (link) await this.attachToLink(link);
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
        this.publish({ state: "disconnected" });
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
        this.publish({ state: "error", error: phase.detail });
        this.deps.notify.error(phase.detail);
        break;
    }
  }

  /**
   * Stand up the wasm flow runtime for `link`, apply the current flow, then
   * hand it the link's inbound stream — the bytes queued since the handshake
   * first, in order. The flow goes in before the replay so a pin change that
   * arrived during attach reaches the node that listens for it.
   *
   * A reactor failure (e.g. wasm load) must not fail the connection — the board
   * is still up; the flow just won't run — but the link stops queueing.
   */
  private async attachToLink(link: BoardConnection): Promise<void> {
    let reactor: ReactorHandle;
    try {
      reactor = await this.deps.attachReactor(link, {
        onEngineFault: (m) => this.onEngineFault(m),
      });
    } catch (reactorError) {
      console.error("[board-controller] flow reactor attach failed:", reactorError);
      link.attachInbound(() => {});
      return;
    }
    if (this.link !== link || this.engineFault !== null) {
      // The link went away (or the engine died) while the runtime loaded.
      reactor.dispose();
      return;
    }
    this.reactor = reactor;
    if (this.latestFlow) reactor.applyFlow(this.latestFlow);
    link.attachInbound((bytes) => reactor.feedBytes(bytes));
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
      startedAt: this.deps.clock.now(),
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

  /** Whether a background path may open a port right now. */
  private mayAutoConnect(): boolean {
    return this.link === null;
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
        if (!this.link) this.publish({ state: "disconnected" });
        return;
      }
      if (this.link) return; // auto-reconnect won the race
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
   * load scan and the reconnect backoff.
   */
  private async reconnectGranted(): Promise<void> {
    if (!this.mayAutoConnect()) return;
    for (const port of await this.deps.serial.listGrantedPorts()) {
      if (!this.mayAutoConnect()) break;
      if (!(await this.looksLikeBoard(port))) continue;
      await this.bringUp(port, { autoFlash: false, explicit: false });
    }
  }

  /**
   * Start the background orchestration once: stand up the boardless flow runtime,
   * reconnect any already-granted board on load, and watch for plug/unplug of
   * granted devices and for the page going away. Idempotent.
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
          if (!this.mayAutoConnect()) return;
          if (!(await this.looksLikeBoard(port))) return;
          await this.bringUp(port, { autoFlash: false, explicit: false });
        }),
      onDisconnect: (port) =>
        void this.run(async () => {
          if (this.link && this.link.port === port) {
            await this.dispatch({ type: "portGone" });
          }
        }),
    });
  }
}
