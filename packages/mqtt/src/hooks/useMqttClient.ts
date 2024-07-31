import mqtt from "mqtt";
import { useCallback, useRef, useState } from "react";


const ConnectionStatusus = ['connected', 'disconnected', 'connecting'] as const
export type ConnectionStatus = typeof ConnectionStatusus[number]

export function useMqttClient() {
  const client = useRef<mqtt.MqttClient>();

  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const subscriptions = useRef(new Map<string, mqtt.OnMessageCallback>());

  const disconnect = useCallback(() => {
    setStatus('disconnected');
    client.current?.end();
    client.current = undefined;
  }, [])

  const unsubscribe = useCallback((topic: string) => {
    subscriptions.current.delete(topic);
    return client.current?.unsubscribeAsync(topic);
  }, [])

  const subscribe = useCallback(async (topic: string, callback: mqtt.OnMessageCallback) => {
    if (subscriptions.current.get(topic)) return;
    subscriptions.current.set(topic, callback);
    await client.current?.subscribeAsync(topic).catch(console.error);

    return () => {
      unsubscribe?.(topic)?.catch(console.error);
    };
  }, [unsubscribe])

  const publish = useCallback(async (topic: string, payload: string) => {
    return client.current?.publishAsync(topic, payload);
  }, [])

  const resubscribe = useCallback(async () => {
    setStatus('connecting');
    for (const topic in Object.keys(subscriptions.current)) {
      const callback = subscriptions.current.get(topic)
      try {
        await unsubscribe(topic)
        await subscribe(topic, callback)
      } catch (e) {
        console.error(e)
      }
    }
    setStatus('connected');
  }, [unsubscribe, subscribe])

  const connect = useCallback((
    options: mqtt.IClientOptions = {
      host: "test.mosquitto.org",
      port: 8081,
    },
  ) => {
    if (client.current) return;

    client.current = mqtt.connect({
      ...options,
      protocol: "wss",
    });

    client.current
      .on("connect", resubscribe)
      .on("error", disconnect)
      .on("disconnect", disconnect)
      .on("close", () => {
        setStatus('disconnected');
      })
      .on("reconnect", resubscribe)
      .on("message", (topic, payload, packet) => {
        Array.from(subscriptions.current.keys()).forEach(subscription => {
          const regexp = new RegExp(subscription.replace(/\//g, "\\/").replace(/\+/g, "\\S+").replace(/#/, "\\S+"))
          if (!topic.match(regexp)) {
            return
          }

          const callback = subscriptions.current.get(subscription)

          if (!callback) {
            return
          }

          try {
            callback(topic, payload, packet)
          } catch {
            console.error('Error in callback for topic', { topic, subscription })
          }
        })
      });

    return () => {
      disconnect();
    }
  }, [resubscribe, disconnect])

  return {
    status,
    connect,
    disconnect,
    subscribe,
    unsubscribe,
    publish,
    subscriptions,
  };
}
