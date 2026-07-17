// Browser board orchestration — the web counterpart to the desktop hardware
// monitor (`apps/web/src-tauri/src/hardware/mod.rs`). The desktop polls serial
// ports in a background thread and, for any recognised board, probes Firmata →
// flashes StandardFirmata if missing → connects, all with zero clicks. The
// browser cannot poll arbitrary ports (Web Serial requires a user gesture +
// picker to *authorise* a device), but once a device is granted it behaves much
// like the desktop:
//
//   • on load            → `getPorts()` reconnects a granted board (no picker)
//   • on plug-in         → the `connect` event reconnects it
//   • on unplug / reset  → tear down and go disconnected
//   • connect (gesture)  → probe → flash-if-missing → connect, one action
//
// So the only irreducible manual step is the first-time authorise per device.
// Everything here drives the shared wasm codec/flasher via ./web-serial.

import { toast } from "sonner";
import { track } from "@/lib/analytics";
import type { BoardState } from "@/lib/bindings/BoardState";
import type { FlowUpdate as CoreFlowUpdate } from "@/lib/bindings/FlowUpdate";
import { useBoardStore } from "@/stores/board";
import { useFigmaStore } from "@/stores/figma";
import { useLlmProviderStore } from "@/stores/llm-provider";
import { useMqttBrokerStore } from "@/stores/mqtt-broker";
import {
  bringUpBoard,
  detectBoard,
  isWebSerialSupported,
  listGrantedPorts,
  onSerialConnectivity,
  requestBoardPort,
  type BoardConnection,
  type WebSerialPort,
} from "./web-serial";
import { FlowReactor, type CloudDeps } from "./flow-reactor";

/** Cloud lookups the reactor needs to perform cloud requests (ADR-0009). Read
 *  live from the provider store via `getState()` (this module is not a React
 *  component) so credential edits apply to the next request without re-attaching.
 *  Direct-by-default per D4: the user's own key in the user's own browser. */
const cloudDeps: CloudDeps = {
  resolveLlmProvider: (id) => {
    const provider = useLlmProviderStore.getState().getProvider(id);
    return provider ? { baseUrl: provider.baseUrl, apiKey: provider.apiKey } : undefined;
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

/** The single active browser board connection (the desktop owns its own). */
let active: BoardConnection | null = null;
/** The wasm flow-runtime host for the active connection. */
let reactor: FlowReactor | null = null;
/** Latest core `FlowUpdate`, applied when a board attaches. */
let latestFlow: CoreFlowUpdate | null = null;
let started = false;
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

async function teardownActive(): Promise<void> {
  reactor?.dispose();
  reactor = null;
  const connection = active;
  active = null;
  await connection?.disconnect();
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

/** Build the bring-up callbacks, wiring board state + a single flashing toast. */
function makeBringUp() {
  let flashToast: string | number | undefined;
  let flashedBoard: string | undefined;
  const options = {
    onState: (state: BoardState) => {
      setBoard(state);
      if (state.state === "flashing") {
        flashedBoard = state.board;
        if (flashToast === undefined) flashToast = toast.loading("Flashing StandardFirmata…");
      }
    },
    onBytes: (bytes: Uint8Array) => {
      // Raw inbound bytes drive the wasm flow runtime (it owns its own decode).
      reactor?.feedBytes(bytes);
    },
    onProgress: (done: number, total: number) => {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      flashToast = toast.loading(`Flashing StandardFirmata… ${pct}%`, { id: flashToast });
    },
    onClosed: () => {
      // The board reset or was unplugged mid-session — drop to disconnected,
      // then try to recover. A reset keeps the USB device present (no `connect`
      // event fires), so rescanning granted ports re-detects it, mirroring the
      // desktop poll's implicit-disconnect handling.
      if (active) {
        reactor?.dispose();
        reactor = null;
        active = null;
        setBoard({ state: "disconnected" });
        void run(reconnectGranted);
      }
    },
  };
  const settle = (ok: boolean) => {
    if (flashToast === undefined) return;
    if (ok) toast.success(`Flashed StandardFirmata to ${flashedBoard ?? "board"}.`, { id: flashToast });
    else toast.dismiss(flashToast);
  };
  return { options, settle };
}

async function bringUp(
  port: WebSerialPort,
  flags: { autoFlash: boolean; explicit: boolean },
): Promise<void> {
  setBoard({ state: "connecting" });
  const { options, settle } = makeBringUp();
  // Capture flash/board facts as they stream through onState so the analytics
  // event can say *which* board connected and whether it needed a flash.
  const startedAt = performance.now();
  const meta = { flashed: false, board: "unknown" };
  const onState = options.onState;
  options.onState = (state: BoardState) => {
    if (state.state === "flashing") meta.flashed = true;
    if ("board" in state && typeof state.board === "string") meta.board = state.board;
    onState(state);
  };
  const trackData = () => ({
    via: flags.explicit ? "gesture" : "auto",
    board: meta.board,
    flashed: meta.flashed,
    seconds: Math.round((performance.now() - startedAt) / 1000),
  });
  try {
    active = await bringUpBoard(port, options, { autoFlash: flags.autoFlash });
    // Stand up the wasm flow runtime for this connection and apply the current
    // flow. A reactor failure (e.g. wasm load) must not fail the connection —
    // the board is still up; the flow just won't run.
    reactor?.dispose();
    try {
      reactor = await FlowReactor.attach(active, cloudDeps);
      if (latestFlow) reactor.applyFlow(latestFlow);
    } catch (reactorError) {
      console.error("[board-controller] flow reactor attach failed:", reactorError);
      reactor = null;
    }
    settle(true);
    track("board_connected", trackData());
  } catch (error) {
    settle(false);
    active = null;
    const message = error instanceof Error ? error.message : String(error);
    track("board_connect_failed", { ...trackData(), error: message.slice(0, 80) });
    if (flags.explicit) {
      setBoard({ state: "error", error: message });
      toast.error(message);
    } else {
      // Background path (auto-reconnect / plug-in): stay quietly disconnected.
      setBoard({ state: "disconnected" });
    }
  }
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
 * Connect from a user gesture: pick a port, then probe → flash-if-missing →
 * connect. `requestPort` must fire synchronously inside the gesture, so it runs
 * *before* the serialised task — only the bring-up is queued.
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
  return run(async () => {
    await teardownActive();
    setBoard({ state: "disconnected" });
  });
}

/**
 * Start the background orchestration once: reconnect any already-granted board
 * on load, and watch for plug/unplug of granted devices. Idempotent; a no-op
 * outside Chromium.
 */
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

export function start(): void {
  if (started || !isWebSerialSupported()) return;
  started = true;

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
          await teardownActive();
          setBoard({ state: "disconnected" });
        }
      }),
  });
}

export function supported(): boolean {
  return isWebSerialSupported();
}
