// Composition root for the browser board controller. The sequencing lives in
// `board-controller-core.ts`, which takes its I/O as constructor arguments; this
// module binds the real ones — Web Serial, the wasm bring-up machine, the
// Zustand stores, sonner — and exposes the single app-wide instance.
//
// Web Serial cannot poll arbitrary ports (a user gesture + picker authorises a
// device), so the only irreducible manual step is the first-time authorise per
// device; granted boards auto-reconnect on load / plug-in / reset like desktop.

import { toast } from "sonner";
import { track as trackEvent } from "@/lib/analytics";
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
} from "./web-serial";
import { createBringUp, handleBringUp } from "./wasm";
import { FlowReactor, type CloudDeps } from "./flow-reactor";
import { isDesktop } from "@/lib/platform";
import { BoardController, type BoardControllerDeps } from "./board-controller-core";

export {
  BoardController,
  type BoardControllerDeps,
  type Notifier,
  type ReactorHandle,
} from "./board-controller-core";

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

/** The production I/O: real Web Serial, the wasm bring-up machine, sonner. */
export const browserBoardDeps: BoardControllerDeps = {
  serial: {
    isSupported: isWebSerialSupported,
    listGrantedPorts,
    requestBoardPort,
    detectBoard,
    probeFirmata,
    probeAfterFlash,
    flashPort,
    onConnectivity: onSerialConnectivity,
    portLabel,
    connectedState,
  },
  createMachine: createBringUp,
  handleEvent: handleBringUp,
  attachReactor: (connection, hooks) => FlowReactor.attach(connection, cloudDeps, hooks),
  setBoard: (state) => useBoardStore.getState().setBoard(state),
  notify: {
    loading: (message, options) => toast.loading(message, options),
    success: (message, options) => toast.success(message, options),
    error: (message) => toast.error(message),
    dismiss: (id) => {
      toast.dismiss(id);
    },
  },
  track: trackEvent,
  isDesktop,
};

// The app's single controller. The bare functions stay the module's interface so
// no call site needs to know an instance exists.
const controller = new BoardController(browserBoardDeps);

export const pushFlowUpdate = (flow: CoreFlowUpdate): void => controller.pushFlowUpdate(flow);
export const dispatchToNode = (nodeId: string, port: string, value: unknown): void =>
  controller.dispatchToNode(nodeId, port, value);
export const connect = (): Promise<void> => controller.connect();
export const disconnect = (): Promise<void> => controller.disconnect();
export const start = (): void => {
  controller.start();
};

export function supported(): boolean {
  return isWebSerialSupported();
}
