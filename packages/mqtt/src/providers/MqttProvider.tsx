import { useContext, useEffect, useRef, useState } from "react";

import { createContext, PropsWithChildren } from "react";
import { ConnectionStatus, useMqttClient } from "../hooks/useMqttClient";

const clients = ["app", "plugin"] as const;
export type Client = (typeof clients)[number];

type UseMqttClientProps = ReturnType<typeof useMqttClient>;
type MqttProviderContextProps = {
  connectedClients: Map<Client, ConnectionStatus>;
};

const MqttProviderContext = createContext<
  UseMqttClientProps & MqttProviderContextProps
>({
  status: "disconnected",
  connectedClients: new Map<Client, ConnectionStatus>(),
  connect: () => {},
  disconnect: () => {},
  subscribe: (...args) => {},
  unsubscribe: (...args) => {},
  publish: (...args) => {},
  subscriptions: {
    current: new Map(),
  },
} as UseMqttClientProps & MqttProviderContextProps);

export function MqttProvider(props: PropsWithChildren & Props) {
  const mqttClient = useMqttClient();
  const { connect, status, subscribe, publish } = mqttClient;
  const [connectedClients, setConnectedClients] = useState<
    Map<Client, ConnectionStatus>
  >(new Map());
  const disconnectedIntervals = useRef<Map<Client, NodeJS.Timeout>>(new Map());

  useEffect(() => {
    connect();
  }, [connect]);

  useEffect(() => {
    if (status !== "connected") return;

    const unsubFromPing = subscribe("fhb/v1/xiduzo/+/ping", (topic) => {
      const from = topic.split("/")[3].toString();
      if (from === props.appName) return; // No need to pong to self
      publish(`fhb/v1/xiduzo/${from}/pong`, props.appName);
    });

    const unsubFromPong = subscribe(
      `fhb/v1/xiduzo/${props.appName}/pong`,
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

    publish(`fhb/v1/xiduzo/${props.appName}/ping`, "");
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
      await publish(`fhb/v1/xiduzo/${props.appName}/ping`, "");
    }, 30000);

    return () => {
      clearInterval(interval);
      unsubFromPing?.then((unsub) => unsub?.());
      unsubFromPong?.then((unsub) => unsub?.());
    };
  }, [status, subscribe, publish, props.appName]);

  return (
    <MqttProviderContext.Provider
      value={{
        ...mqttClient,
        connectedClients,
      }}
    >
      {props.children}
    </MqttProviderContext.Provider>
  );
}

type Props = {
  appName: Client;
};

export const useMqtt = () => useContext(MqttProviderContext);
