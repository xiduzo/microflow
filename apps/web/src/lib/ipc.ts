import { invoke } from "@tauri-apps/api/core";
import { listen, type Event } from "@tauri-apps/api/event";
import { type Node, type Edge } from "@xyflow/react";
import { isDesktop } from "./platform";
import { useEffect } from "react";

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

type Command = Flow | MqttConnect | MqttDisconnect | MqttSubscribe | MqttUnsubscribe | MqttPublish | MqttStatus;

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

export type MqttMessagePayload = {
  broker_id: string;
  topic: string;
  payload: string;
};

export type ComponentEventPayload = {
  source: string;
  sourceHandle: string;
  value: boolean | number | string | { r: number; g: number; b: number; a: number } | unknown[];
  edgeId?: string;
};

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
