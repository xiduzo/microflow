import { create } from "zustand";
import type { OnMessageCallback } from "mqtt";
import type mqtt from "mqtt";
import type { IClientPublishOptions } from "mqtt";
import type { MqttConfig, Client, ConnectionStatus } from "./types";
import { MqttClientManager } from "./client";

export type MqttStore = {
  // Connection state
  status: ConnectionStatus;
  appName: Client;
  uniqueId: string;
  connectedClients: Array<{ appName: Client; status: ConnectionStatus }>;

  // Actions
  connect: (config: MqttConfig, appName: Client) => void;
  subscribe: (
    topic: string,
    callback: OnMessageCallback,
    options?: mqtt.IClientSubscribeOptions | mqtt.IClientSubscribeProperties
  ) => () => void;
  publish: (
    topic: string,
    payload: string,
    options?: IClientPublishOptions
  ) => void;
};

// Singleton instance of the MQTT client manager
const clientManager = new MqttClientManager();

export const useMqttStore = create<MqttStore>((set, get) => {
  // Subscribe to status changes
  const unsubscribeStatus = clientManager.onStatusChange((status) => {
    set({ status });
  });

  // Subscribe to connected clients changes
  const unsubscribeClients = clientManager.onConnectedClientsChange(
    (connectedClients) => {
      set({ connectedClients });
    }
  );

  return {
    // Initial state
    status: "disconnected",
    appName: "app",
    uniqueId: "",
    connectedClients: [],

    // Actions
    connect: async (config: MqttConfig, appName: Client) => {
      await clientManager.connect(config, appName);
      set({
        appName,
        uniqueId: config.uniqueId,
        status: clientManager.getStatus(),
        connectedClients: clientManager.getConnectedClients(),
      });
    },

    subscribe: (
      topic: string,
      callback: OnMessageCallback,
      options?: mqtt.IClientSubscribeOptions | mqtt.IClientSubscribeProperties
    ) => {
      return clientManager.subscribe(topic, callback, options);
    },

    publish: (
      topic: string,
      payload: string,
      options?: IClientPublishOptions
    ) => {
      clientManager.publish(topic, payload, options);
    },
  };
});
