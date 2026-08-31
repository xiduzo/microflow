import { invoke } from "@tauri-apps/api/core";
import { listen, type Event } from "@tauri-apps/api/event";
import { type Node, type Edge } from "@xyflow/react";
import { isDesktop } from "./platform";
import { useEffect, useRef } from "react";

// Generated bindings: ts-rs writes one file per #[derive(TS)] type into
// ./bindings/ during `cargo test`. Always import event-payload types from
// there so the Rust struct stays the single source of truth.
import type { BoardState } from "./bindings/BoardState";
import type { FlowUpdate } from "./bindings/FlowUpdate";
import type { BoardTarget } from "./bindings/BoardTarget";
import type { BrokerStatus } from "./bindings/BrokerStatus";
import type { Credentials } from "./bindings/Credentials";
import type { ComponentEvent } from "./bindings/ComponentEvent";
import type { ConnectionStatus } from "./bindings/ConnectionStatus";
import type { MqttMessage } from "./bindings/MqttMessage";
import type { PinInfo } from "./bindings/PinInfo";
import type { SerialPortEvent } from "./bindings/SerialPortEvent";
import type { SerialPortInfo } from "./bindings/SerialPortInfo";
import type { MissingCredential } from "./bindings/MissingCredential";

export type {
  BoardState,
  BrokerStatus,
  ComponentEvent,
  ConnectionStatus,
  Credentials,
  MissingCredential,
  MqttMessage,
  PinInfo,
  SerialPortEvent,
  SerialPortInfo,
};

type ErrorResponse = {
  success: false;
  error: string;
};

type OkResponse<T extends Record<string, unknown>> = {
  success: true;
  message?: string;
  data?: T;
};
type Response<T extends Record<string, unknown> = Record<string, unknown>> =
  | ErrorResponse
  | OkResponse<T>;

type BrokerConfig = {
  id: string;
  name: string;
  url: string;
  username?: string;
  password?: string;
};

type Flow = {
  type: "flow_update";
  // The core `microflow_core::flow::FlowUpdate` shape (ts-rs binding) — the
  // Rust command deserialises exactly this, so the sender must not pass raw
  // React Flow nodes/edges (core requires non-optional edge handles).
  flow: FlowUpdate;
  brokers?: BrokerConfig[];
  providers?: ProviderConfig[];
};

type MqttConnect = {
  type: "mqtt_connect";
  brokerId: string;
  url: string;
  username?: string;
  password?: string;
};

type MqttDisconnect = {
  type: "mqtt_disconnect";
  brokerId: string;
};

type MqttSubscribe = {
  type: "mqtt_subscribe";
  brokerId: string;
  topic: string;
};

type MqttUnsubscribe = {
  type: "mqtt_unsubscribe";
  brokerId: string;
  topic: string;
};

type MqttPublish = {
  type: "mqtt_publish";
  brokerId: string;
  topic: string;
  payload: string;
  retain?: boolean;
};

type MqttStatus = {
  type: "mqtt_status";
  brokerId: string;
};

type MqttSyncBrokers = {
  type: "mqtt_sync_brokers";
  brokers: BrokerConfig[];
};

type MqttAllStatuses = {
  type: "mqtt_all_statuses";
};

// Still carried on `flow_update` for the dispatcher's change detection, but the
// desktop ignores it: since ADR-0021 the webview owns the LLM transport and
// resolves providers from its own store, so there is no registry to fill. The
// `llm_sync_providers` / `llm_test_provider` commands are gone with it.
type ProviderConfig = {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
};

// Sketch Generation context: translate a Flow into an Arduino sketch for the
// selected board target. Returns a `GenerationOutcome` — either the generated
// `.ino` source or the validation problems that prevented emission. `targetId`
// is optional; the backend uses the default board target when it is omitted.
// `credentials` carries the Author-supplied network credentials a Cloud-capable
// Sketch uses to connect on boot; secret fields are masked in the UI and never
// persisted in the Flow. Omitted for non-Cloud Flows.
type GenerateSketch = {
  type: "generate_sketch";
  flow: {
    nodes: Node[];
    edges: Edge[];
  };
  targetId?: string;
  credentials?: Credentials;
};

// Local agent CLIs as an LLM provider (desktop only) — see
// `lib/ai/cli-providers.ts` for why these cannot go over the HTTP transport.
// `bin` is checked against an allowlist in Rust; `args` never reaches a shell.
type LlmCliGenerate = {
  type: "llm_cli_generate";
  bin: string;
  args: string[];
  prompt: string;
};

type LlmCliProbe = {
  type: "llm_cli_probe";
  bin: string;
};

type LlmCliModels = {
  type: "llm_cli_models";
  bin: string;
  args: string[];
};

type Command =
  | Flow
  | LlmCliGenerate
  | LlmCliProbe
  | LlmCliModels
  | MqttConnect
  | MqttDisconnect
  | MqttSubscribe
  | MqttUnsubscribe
  | MqttPublish
  | MqttStatus
  | MqttSyncBrokers
  | MqttAllStatuses
  | GenerateSketch;

export async function invokeCommand<
  TCommand extends Command,
  TResponse extends Record<string, unknown>,
>(command: TCommand): Promise<Response<TResponse>> {
  if (!isDesktop()) return { success: false, error: "Not running on desktop" };

  const { type, ...payload } = command;
  try {
    // Deliberately logs the command name only. The payload carries MQTT broker
    // passwords and LLM API keys (see `gatherBrokers` / `gatherProviders`), and
    // on the hot `flow_update` path it is the entire flow — so logging it both
    // leaked credentials into devtools and log files and cost a full
    // serialisation on every accepted change from anyone in the room.
    console.log("[INVOKE-COMMAND]", type);
    const data = await invoke<unknown>(type, payload);
    return { success: true, data } as OkResponse<TResponse>;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
}

// Sketch Generation context: list the board targets the Author can generate a
// Sketch for. Backed by `runtime::commands::list_board_targets`, which mirrors
// the `supported_targets()` registry generation consults. Returns an empty list
// off-desktop so the editor degrades gracefully (no picker options).
export async function listBoardTargets(): Promise<BoardTarget[]> {
  if (!isDesktop()) return [];
  try {
    return await invoke<BoardTarget[]>("list_board_targets");
  } catch (error) {
    console.error("[listBoardTargets]", error);
    return [];
  }
}

// Sketch Generation context: report which required network credentials are
// missing for a Flow on the selected board target, so the editor can warn the
// Author before generating a Sketch that would silently fail to connect.
// Returns an empty list when no credential is required (no Cloud Nodes, or a
// non-networking target) or off-desktop. Secret values are never logged.
export async function checkCredentials(
  flow: { nodes: Node[]; edges: Edge[] },
  targetId?: string,
  credentials?: Credentials,
): Promise<MissingCredential[]> {
  if (!isDesktop()) return [];
  try {
    return await invoke<MissingCredential[]>("check_credentials", {
      flow,
      targetId,
      credentials,
    });
  } catch (error) {
    console.error("[checkCredentials]", error);
    return [];
  }
}

// Legacy aliases kept for existing call sites; generated types are the source
// of truth (see imports at the top of this file).
export type MqttMessagePayload = MqttMessage;
export type BrokerStatusPayload = BrokerStatus;
export type ComponentEventPayload = ComponentEvent;

export function useListen<T>(event: { type: string; handler: (event: Event<T>) => void }) {
  // Keep the latest handler in a ref so callers can pass a fresh inline object
  // every render without tearing down and re-creating the Tauri listener. A
  // re-subscribe loop drops events that arrive during the unlisten/relisten
  // gap (e.g. the transient `connecting` board-state burst).
  const handlerRef = useRef(event.handler);
  handlerRef.current = event.handler;

  const { type } = event;
  useEffect(() => {
    if (!isDesktop()) return;
    const listener = listen<T>(type, (e) => handlerRef.current(e));

    return () => {
      listener.then((unlisten) => unlisten()).catch((error) => console.error(error));
    };
  }, [type]);
}
