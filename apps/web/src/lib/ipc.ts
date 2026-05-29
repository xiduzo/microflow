import { invoke } from "@tauri-apps/api/core";
import { listen, type Event } from "@tauri-apps/api/event";
import { type Node, type Edge } from "@xyflow/react";
import { isDesktop } from "./platform";
import { useEffect } from "react";

// Generated bindings: ts-rs writes one file per #[derive(TS)] type into
// ./bindings/ during `cargo test`. Always import event-payload types from
// there so the Rust struct stays the single source of truth.
import type { BoardState } from "./bindings/BoardState";
import type { BrokerStatus } from "./bindings/BrokerStatus";
import type { ComponentEvent } from "./bindings/ComponentEvent";
import type { ConnectionStatus } from "./bindings/ConnectionStatus";
import type { MqttMessage } from "./bindings/MqttMessage";
import type { PinInfo } from "./bindings/PinInfo";
import type { SerialPortEvent } from "./bindings/SerialPortEvent";
import type { SerialPortInfo } from "./bindings/SerialPortInfo";

export type {
  BoardState,
  BrokerStatus,
  ComponentEvent,
  ConnectionStatus,
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
  flow: {
    nodes: Node[];
    edges: Edge[];
  };
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

type ProviderConfig = {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
};

type LlmSyncProviders = {
  type: "llm_sync_providers";
  providers: ProviderConfig[];
};

type LlmTestProvider = {
  type: "llm_test_provider";
  baseUrl: string;
  apiKey: string;
};

// Sketch Generation context: translate a Flow into an Arduino sketch. Returns
// the generated .ino source as a string. No UI consumes this yet (see #23).
type GenerateSketch = {
  type: "generate_sketch";
  flow: {
    nodes: Node[];
    edges: Edge[];
  };
};

type Command =
  | Flow
  | MqttConnect
  | MqttDisconnect
  | MqttSubscribe
  | MqttUnsubscribe
  | MqttPublish
  | MqttStatus
  | MqttSyncBrokers
  | MqttAllStatuses
  | LlmSyncProviders
  | LlmTestProvider
  | GenerateSketch;

export async function invokeCommand<
  TCommand extends Command,
  TResponse extends Record<string, unknown>,
>(command: TCommand): Promise<Response<TResponse>> {
  if (!isDesktop()) return { success: false, error: "Not running on desktop" };

  const { type, ...payload } = command;
  try {
    console.log("[INVOKE-COMMAND] <invokeCommand>", type, payload);
    const data = await invoke<unknown>(type, payload);
    return { success: true, data } as OkResponse<TResponse>;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
}

// Legacy aliases kept for existing call sites; generated types are the source
// of truth (see imports at the top of this file).
export type MqttMessagePayload = MqttMessage;
export type BrokerStatusPayload = BrokerStatus;
export type ComponentEventPayload = ComponentEvent;

export function useListen<T>(event: { type: string; handler: (event: Event<T>) => void }) {
  useEffect(() => {
    if (!isDesktop()) return;
    const { type, handler } = event;
    const listener = listen<T>(type, handler);

    return () => {
      listener.then((unlisten) => unlisten()).catch((error) => console.error(error));
    };
  }, [event]);
}
