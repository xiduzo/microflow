import { useContext, useEffect, useRef, useState } from "react";

import mqtt from "mqtt/*";
import { createContext, PropsWithChildren } from "react";
import { ConnectionStatus, useMqttClient } from "../hooks/useMqttClient";

const clients = ["app", "plugin"] as const;
export type Client = (typeof clients)[number];

type UseMqttClientProps = ReturnType<typeof useMqttClient>;
type MqttProviderContextProps = {
  connectedClients: Map<Client, ConnectionStatus>;
  appName: Client;
  uniqueId: string;
};

const MqttProviderContext = createContext<
  UseMqttClientProps & MqttProviderContextProps
>({
  status: "disconnected",
  connectedClients: new Map<Client, ConnectionStatus>(),
  connect: () => { },
  disconnect: () => { },
  subscribe: (...args) => { },
  unsubscribe: (...args) => { },
  publish: (...args) => { },
  subscriptions: {
    current: new Map(),
  },
  appName: "app",
  uniqueId: "",
} as UseMqttClientProps & MqttProviderContextProps);

export function MqttProvider(props: PropsWithChildren & Props) {
  const mqttClient = useMqttClient();
  const { connect, status, subscribe, publish, subscriptions, unsubscribe } = mqttClient;
  const [connectedClients, setConnectedClients] = useState<
    Map<Client, ConnectionStatus>
  >(new Map());
  const disconnectedIntervals = useRef<Map<Client, NodeJS.Timeout>>(new Map());

  useEffect(() => {
    connect(props.config);
  }, [connect, props.config]);

  useEffect(() => {
    Object.keys(subscriptions.current).forEach((topic) => {
      unsubscribe(topic);
    });
  }, [props.uniqueId, unsubscribe])

  useEffect(() => {
    if (status !== "connected") return;

    const unsubFromPing = subscribe(`fhb/v1/${props.uniqueId}/+/ping`, (topic) => {
      const from = topic.split("/")[3].toString();
      if (from === props.appName) return; // No need to pong to self
      // if we received a ping it is connected
      setConnectedClients((prev) => {
        prev.set(from as Client, "connected");
        return new Map(prev);
      });
      publish(`fhb/v1/${props.uniqueId}/${from}/pong`, props.appName);
    });

    const unsubFromPong = subscribe(
      `fhb/v1/${props.uniqueId}/${props.appName}/pong`,
      (topic, message) => {
        setConnectedClients((prev) => {
          const client = message.toString() as Client;
          prev.set(client, "connected");
          const interval = disconnectedIntervals.current.get(client);
          if (interval) {
            clearTimeout(interval);
          }
          return new Map(prev);
        });
      },
    );

    publish(`fhb/v1/${props.uniqueId}/${props.appName}/ping`, "");
    const interval = setInterval(async () => {
      setConnectedClients((prev) => {
        prev.forEach((_status, client) => {
          prev.set(client, "connecting");
          disconnectedIntervals.current.set(
            client,
            setTimeout(() => {
              setConnectedClients((prev) => {
                prev.set(client, "disconnected");
                return new Map(prev);
              });
            }, 5000),
          );
        });
        return new Map(prev);
      });
      await publish(`fhb/v1/${props.uniqueId}/${props.appName}/ping`, "");
    }, 30000);

    return () => {
      clearInterval(interval);
      unsubFromPing?.then((unsub) => unsub?.());
      unsubFromPong?.then((unsub) => unsub?.());
    };
  }, [status, subscribe, publish, props.appName, props.uniqueId]);

  return (
    <MqttProviderContext.Provider
      value={{
        ...mqttClient,
        connectedClients,
        appName: props.appName,
        uniqueId: props.uniqueId,
      }}
    >
      {props.children}
    </MqttProviderContext.Provider>
  );
}

export type MqttConfig = Pick<mqtt.IClientOptions, "username" | "password" | "host" | "port">
type Props = {
  appName: Client;
  uniqueId: string;
  config?: MqttConfig;
};

export const useMqtt = () => useContext(MqttProviderContext);
