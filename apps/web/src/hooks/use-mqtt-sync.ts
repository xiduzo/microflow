import { useEffect, useRef } from "react";
import { useMqttBrokerStore, type ConnectionStatus } from "@/stores/mqtt-broker";
import { invokeCommand, useListen, type BrokerStatusPayload } from "@/lib/ipc";
import { isDesktop } from "@/lib/platform";

/**
 * Hook that syncs MQTT broker configs to the Tauri backend.
 * - On mount: syncs all brokers and connects to them
 * - On broker changes: syncs updated configs
 * - Listens for status updates from backend
 */
export function useMqttSync() {
  const brokers = useMqttBrokerStore((s) => s.brokers);
  const setStatuses = useMqttBrokerStore((s) => s.setStatuses);
  const initialSyncDone = useRef(false);

  // Sync brokers to backend whenever they change
  useEffect(() => {
    if (!isDesktop()) return;

    const syncBrokers = async () => {
      const result = await invokeCommand<
        { type: "mqtt_sync_brokers"; brokers: typeof brokers },
        { data?: BrokerStatusPayload[] }
      >({
        type: "mqtt_sync_brokers",
        brokers: brokers.map((b) => ({
          id: b.id,
          name: b.name,
          url: b.url,
          username: b.username,
          password: b.password,
          isDefault: b.isDefault
        })),
      });

      if (result.success && result.data) {
        const statusMap: Record<string, ConnectionStatus> = {};
        for (const status of result.data as unknown as BrokerStatusPayload[]) {
          statusMap[status.id] = status.status;
        }
        setStatuses(statusMap);
      }

      initialSyncDone.current = true;
    };

    syncBrokers();
  }, [brokers, setStatuses]);

  // Listen for status updates from backend
  useListen<BrokerStatusPayload[]>({
    type: "mqtt-broker-status",
    handler: (event) => {
      const statusMap: Record<string, ConnectionStatus> = {};
      for (const status of event.payload) {
        statusMap[status.id] = status.status;
      }
      setStatuses(statusMap);
    },
  });
}

/**
 * Get the connection status for a specific broker
 */
export function useBrokerStatus(brokerId: string): ConnectionStatus {
  return useMqttBrokerStore((s) => s.statuses[brokerId] ?? "disconnected");
}
