// Browser board bring-up adapter — the web counterpart to the desktop hardware
// monitor (`apps/web/src-tauri/src/hardware/mod.rs`). The bring-up POLICY —
// probe → flash StandardFirmata if missing → connect → auto-reconnect, plus the
// disconnected→connecting→flashing→connected→error transitions — lives once in
// the shared sans-IO `microflow_core::bringup` state machine (via the firmata
// wasm crate); both hosts drive the same machine. This module only:
//
//   • feeds Web Serial happenings in as machine events (plug/unplug, gesture,
//     probe/flash results), and
//   • performs the actions the machine returns (serial probe, flash via the
//     shared codec, Zustand store updates, toasts).
//
// Web Serial cannot poll arbitrary ports (a user gesture + picker authorises a
// device), so the only irreducible manual step is the first-time authorise per
// device; granted boards auto-reconnect on load / plug-in / reset like desktop.

import { toast } from "sonner";
import { track } from "@/lib/analytics";
import type { BoardState } from "@/lib/bindings/BoardState";
import type { FlowUpdate as CoreFlowUpdate } from "@/lib/bindings/FlowUpdate";
import { useBoardStore } from "@/stores/board";
import { useFigmaStore } from "@/stores/figma";
import { useLlmProviderStore } from "@/stores/llm-provider";
import { useMqttBrokerStore } from "@/stores/mqtt-broker";
import {
  connectedState,
  detectBoard,
  flashPort,
  isWebSerialSupported,
  listGrantedPorts,
  onSerialConnectivity,
  portLabel,
  probeAfterFlash,
  probeFirmata,
  requestBoardPort,
  type BoardConnection,
  type ProbeHooks,
  type WebSerialPort,
} from "./web-serial";
import {
  createBringUp,
  handleBringUp,
  type BringUpAction,
  type BringUpEvent,
  type BringUpMachine,
  type BringUpPhase,
} from "./wasm";
import { FlowReactor, type CloudDeps } from "./flow-reactor";
import { isDesktop } from "@/lib/platform";

/** Cloud lookups the reactor needs to perform cloud requests (ADR-0009). Read
 *  live from the provider store via `getState()` (this module is not a React
 *  component) so credential edits apply to the next request without re-attaching.
 *  Direct-by-default per D4: the user's own key in the user's own browser. */
const cloudDeps: CloudDeps = {
  resolveLlmProvider: (id) => {
    const provider = useLlmProviderStore.getState().getProvider(id);
    return provider
      ? { kind: provider.kind, baseUrl: provider.baseUrl, apiKey: provider.apiKey }
      : undefined;
  },
  resolveBroker: (id) => {
    const broker = useMqttBrokerStore.getState().getBroker(id);
    return broker
      ? { id: broker.id, url: broker.url, username: broker.username, password: broker.password }
      : undefined;
  },
  // Feed inbound Figma display topics (variables list / plugin status) into the
  // figma store — the browser counterpart of the desktop "mqtt-message" event.
  onMqttMessage: (topic, payload) => {
    useFigmaStore.getState().ingestMqttMessage(topic, new TextDecoder().decode(payload));
  },
};

/** The single active browser board connection — the adapter's I/O handle; every
 *  DECISION about it comes from the shared bring-up machine. */
let active: BoardConnection | null = null;
/** The wasm flow-runtime host for the active connection. */
let reactor: FlowReactor | null = null;
/** Latest core `FlowUpdate`, applied when a board attaches. */
let latestFlow: CoreFlowUpdate | null = null;
/** The shared bring-up policy machine (lazy: wasm loads on first use). */
let machinePromise: Promise<BringUpMachine> | null = null;
let started = false;
// A trapped wasm module never runs a flow again (ADR-0017); latched so the
// boardless runtime is not respawned into the same fault on every disconnect.
let engineDead = false;
// Serialise every port operation so connect / auto-reconnect / plug events never
// race to open the same port.
let queue: Promise<unknown> = Promise.resolve();

function run<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  // Keep the chain alive regardless of individual task outcome.
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function setBoard(state: BoardState): void {
  useBoardStore.getState().setBoard(state);
}

/**
 * Push the latest flow graph to the runtime. Called by `WasmFlowUpdateSender`
 * on every graph change; stored so a board connecting later starts on the
 * current flow.
 */
export function pushFlowUpdate(flow: CoreFlowUpdate): void {
  latestFlow = flow;
  reactor?.applyFlow(flow);
}

/**
 * Stand up a runtime with no board behind it, so the software half of a flow
 * (Hotkey, Interval, Llm, Mqtt, Midi, …) runs from page load instead of waiting
 * for hardware that may never arrive. Replaced by a board-backed runtime when
 * one connects, and restored when it goes away.
 *
 * Never revives a runtime killed by an engine fault: that module is trapped, and
 * a fresh one would just re-run the flow that trapped it (ADR-0017).
 */
function ensureBoardlessReactor(): void {
  if (isDesktop() || engineDead || reactor !== null) return;
  void run(async () => {
    // `run` serialises against bring-up, so a board may have won the race.
    if (reactor !== null || active !== null || engineDead) return;
    try {
      reactor = await FlowReactor.attach(null, cloudDeps, { onEngineFault });
      if (latestFlow) reactor.applyFlow(latestFlow);
    } catch (error) {
      console.error("[board-controller] boardless reactor attach failed:", error);
      reactor = null;
    }
  });
}

/**
 * Deliver one host-originated input (today: a hotkey key event) to a node's
 * port. A no-op only while the runtime is down (an engine fault).
 */
export function dispatchToNode(nodeId: string, port: string, value: unknown): void {
  reactor?.dispatchToNode(nodeId, port, value);
}

// --- Machine adapter --------------------------------------------------------

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
let attempt: Attempt | null = null;

function trackData(a: Attempt) {
  return {
    via: a.explicit ? "gesture" : "auto",
    board: a.board,
    flashed: a.flashed,
    seconds: Math.round((performance.now() - a.startedAt) / 1000),
  };
}

/** Feed one event into the shared machine and perform the returned actions. */
async function dispatch(event: BringUpEvent): Promise<void> {
  machinePromise ??= createBringUp();
  const machine = await machinePromise;
  const actions = handleBringUp(machine, event);
  for (const action of actions) {
    await perform(action);
  }
}

/**
 * The wasm flow engine died — a Rust panic traps the module, so no flow will run
 * again on this runtime (ADR-0017). Drop the reactor so nothing calls back into
 * the dead module, and surface it on the board-level error state.
 *
 * Deliberately NOT a bring-up event: the port is open and the board is fine, so
 * `connectionLost` would be a lie, and the machine's retry would close a working
 * port to reconnect into the same dead module, forever. This sets the store
 * directly instead — a *notify* without a transition.
 *
 * It uses the `error` state rather than a toast alone because the condition is
 * persistent and a toast is not: until the page reloads, this board runs no
 * flow, and a UI still reading `connected` would say otherwise. Reload is the
 * recovery (a trapped module cannot be revived in place), which is also why it
 * does not matter that `connect()` short-circuits while `active` is set.
 */
function onEngineFault(message: string): void {
  engineDead = true;
  reactor?.dispose();
  reactor = null;
  console.error("[board-controller] flow engine fault:", message);
  setBoard({ state: "error", error: message });
  toast.error(message);
}

/** The probe hooks: raw bytes feed the flow runtime; an unexpected read-loop
 *  end while connected re-enters the machine as `connectionLost`. */
function probeHooks(): ProbeHooks {
  return {
    // Only once a connection is live: mid-bring-up the reactor is still the
    // boardless one, whose empty pin table cannot decode this board's traffic.
    onBytes: (bytes) => {
      if (active) reactor?.feedBytes(bytes);
    },
    onClosed: () => void run(() => dispatch({ type: "connectionLost" })),
  };
}

async function perform(action: BringUpAction): Promise<void> {
  switch (action.type) {
    case "probe": {
      const a = attempt;
      if (!a) return;
      const probe = action.afterFlash ? probeAfterFlash : probeFirmata;
      const connection = await probe(a.port, probeHooks()).catch(() => null);
      if (connection) {
        active = connection;
        await dispatch({ type: "probeOk" });
      } else {
        await dispatch({ type: "probeFailed" });
      }
      break;
    }
    case "flash": {
      const a = attempt;
      if (!a) return;
      try {
        await flashPort(a.port, {
          onProgress: (done, total) => void dispatch({ type: "flashProgress", done, total }),
        });
        await dispatch({ type: "flashOk" });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await dispatch({ type: "flashFailed", detail });
      }
      break;
    }
    case "closePort": {
      reactor?.dispose();
      reactor = null;
      const connection = active;
      active = null;
      await connection?.disconnect();
      // The board is gone, the flow is not: fall back to the boardless runtime.
      ensureBoardlessReactor();
      break;
    }
    case "scheduleRetry":
      // A reset keeps the USB device present (no `connect` event fires), so
      // rescanning granted ports re-detects it — the browser's retry primitive.
      void run(reconnectGranted);
      break;
    case "notifyFlashProgress": {
      if (attempt?.flashToast !== undefined) {
        attempt.flashToast = toast.loading(`Flashing StandardFirmata… ${action.percent}%`, {
          id: attempt.flashToast,
        });
      }
      break;
    }
    case "notify":
      await applyPhase(action.phase);
      break;
  }
}

/** Map a machine phase onto the board store + toasts (presentation only). */
async function applyPhase(phase: BringUpPhase): Promise<void> {
  const a = attempt;
  switch (phase.kind) {
    case "connecting":
      setBoard({ state: "connecting" });
      break;
    case "flashing": {
      if (a) {
        a.flashed = true;
        a.board = phase.board;
        a.flashToast ??= toast.loading("Flashing StandardFirmata…");
      }
      setBoard({
        state: "flashing",
        port: a ? portLabel(a.port.getInfo()) : "Serial port",
        board: phase.board,
      });
      break;
    }
    case "connected": {
      if (active) setBoard(connectedState(active.port, active.session));
      if (a?.flashToast !== undefined) {
        toast.success(`Flashed StandardFirmata to ${a.board}.`, { id: a.flashToast });
        a.flashToast = undefined;
      }
      // Stand up the wasm flow runtime for this connection and apply the
      // current flow. A reactor failure (e.g. wasm load) must not fail the
      // connection — the board is still up; the flow just won't run.
      reactor?.dispose();
      reactor = null;
      if (active) {
        try {
          reactor = await FlowReactor.attach(active, cloudDeps, { onEngineFault });
          if (latestFlow) reactor.applyFlow(latestFlow);
        } catch (reactorError) {
          console.error("[board-controller] flow reactor attach failed:", reactorError);
          reactor = null;
        }
      }
      if (a) {
        track("board_connected", trackData(a));
        attempt = null;
      }
      break;
    }
    case "disconnected":
      if (a?.flashToast !== undefined) {
        toast.dismiss(a.flashToast);
        a.flashToast = undefined;
      }
      if (a) {
        // A bring-up attempt ended quietly (background probe miss).
        track("board_connect_failed", { ...trackData(a), error: "no firmata" });
        attempt = null;
      }
      setBoard({ state: "disconnected" });
      break;
    case "error":
      if (a?.flashToast !== undefined) {
        toast.dismiss(a.flashToast);
        a.flashToast = undefined;
      }
      if (a) {
        track("board_connect_failed", { ...trackData(a), error: phase.detail.slice(0, 80) });
        attempt = null;
      }
      // Full detail reaches the store + toast (do not collapse it — 7c8f7e2).
      setBoard({ state: "error", error: phase.detail });
      toast.error(phase.detail);
      break;
  }
}

/** Start a bring-up attempt for `port`; the machine takes it from here. */
async function bringUp(
  port: WebSerialPort,
  flags: { autoFlash: boolean; explicit: boolean },
): Promise<void> {
  const board = await detectBoard(port).catch(() => undefined);
  attempt = {
    port,
    explicit: flags.explicit,
    startedAt: performance.now(),
    board: board ?? "unknown",
    flashed: false,
  };
  await dispatch({
    type: "portReady",
    board: board ?? null,
    autoFlash: flags.autoFlash,
    explicit: flags.explicit,
  });
}

/** Cheap pre-check so auto paths don't handshake unrelated granted serial devices. */
async function looksLikeBoard(port: WebSerialPort): Promise<boolean> {
  try {
    return Boolean(await detectBoard(port));
  } catch {
    return false;
  }
}

/**
 * Connect from a user gesture: pick a port, then let the machine run probe →
 * flash-if-missing → connect. `requestPort` must fire synchronously inside the
 * gesture, so it runs *before* the serialised task — only the bring-up is queued.
 */
export function connect(): Promise<void> {
  if (!isWebSerialSupported()) return Promise.resolve();
  // requestPort MUST run inside the user gesture — fire it now, before queueing.
  // Wrap so a dismissed picker never surfaces as an unhandled rejection while the
  // bring-up waits its turn behind the load scan.
  const picked = requestBoardPort().then(
    (port): { port: WebSerialPort | null } => ({ port }),
    (): { port: WebSerialPort | null } => ({ port: null }),
  );
  return run(async () => {
    const { port } = await picked;
    if (!port) {
      // Picker dismissed — not an error.
      if (!active) setBoard({ state: "disconnected" });
      return;
    }
    if (active) return; // auto-reconnect won the race
    await bringUp(port, { autoFlash: true, explicit: true });
  });
}

export function disconnect(): Promise<void> {
  track("board_disconnected", { via: "gesture" });
  return run(() => dispatch({ type: "disconnectRequested" }));
}

/**
 * Reconnect a granted board — recognised boards only, so we never hang
 * handshaking an unrelated serial device the user once authorised. Shared by the
 * load scan and the reset-recovery path.
 */
async function reconnectGranted(): Promise<void> {
  if (active) return;
  for (const port of await listGrantedPorts()) {
    if (active) break;
    if (!(await looksLikeBoard(port))) continue;
    await bringUp(port, { autoFlash: false, explicit: false });
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
export function start(): void {
  if (started || isDesktop()) return;
  started = true;

  ensureBoardlessReactor();

  if (!isWebSerialSupported()) return;

  // Reconnect a granted board on load (no picker; common case: a board that
  // already has Firmata just comes back).
  void run(reconnectGranted);

  onSerialConnectivity({
    onConnect: (port) =>
      void run(async () => {
        if (active) return;
        if (!(await looksLikeBoard(port))) return;
        await bringUp(port, { autoFlash: false, explicit: false });
      }),
    onDisconnect: (port) =>
      void run(async () => {
        if (active && active.port === port) {
          await dispatch({ type: "portGone" });
        }
      }),
  });
}

export function supported(): boolean {
  return isWebSerialSupported();
}
