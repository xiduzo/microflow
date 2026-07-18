import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useMqttBrokerStore, type ConnectionStatus } from "@/stores/mqtt-broker";
import { useLlmProviderStore } from "@/stores/llm-provider";
import { useFigmaStore } from "@/stores/figma";
import { invokeCommand, type BrokerStatusPayload } from "@/lib/ipc";
import { isDesktop } from "@/lib/platform";
import {
  assembleHostSnapshot,
  startCloudCapabilitySync,
  type CloudCapability,
} from "./cloud-capability-sync";
import type { HostSnapshot } from "./flow-update-dispatcher";

// Production cloud-capability registry: each entry owns its store slice, its
// push to the runtime host's Service Registry, and its HostSnapshot field.
// The driver + snapshot assembly live in `cloud-capability-sync.ts`.

function toStatusMap(statuses: BrokerStatusPayload[]): Record<string, ConnectionStatus> {
  const map: Record<string, ConnectionStatus> = {};
  for (const status of statuses) {
    map[status.id] = status.status;
  }
  return map;
}

const mqtt: CloudCapability = {
  name: "mqtt",
  sync: {
    read: () => useMqttBrokerStore.getState().brokers,
    subscribe: (onChange) => useMqttBrokerStore.subscribe(onChange),
    push: async () => {
      const { brokers, setStatuses } = useMqttBrokerStore.getState();
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
          isDefault: b.isDefault,
        })),
      });
      if (result.success && result.data) {
        setStatuses(toStatusMap(result.data as unknown as BrokerStatusPayload[]));
      }
    },
  },
  // Runtime→store feedback: connection status pushed by the backend.
  listen: () => {
    const listener = listen<BrokerStatusPayload[]>("mqtt-broker-status", (event) => {
      useMqttBrokerStore.getState().setStatuses(toStatusMap(event.payload));
    });
    return () => {
      listener.then((unlisten) => unlisten()).catch((error) => console.error(error));
    };
  },
  snapshot: () => ({ brokers: useMqttBrokerStore.getState().brokers }),
};

const llm: CloudCapability = {
  name: "llm",
  sync: {
    read: () => useLlmProviderStore.getState().providers,
    subscribe: (onChange) => useLlmProviderStore.subscribe(onChange),
    push: () => {
      const { providers, setStatus } = useLlmProviderStore.getState();
      invokeCommand({
        type: "llm_sync_providers",
        providers: providers.map((p) => ({
          id: p.id,
          name: p.name,
          base_url: p.baseUrl,
          api_key: p.apiKey,
        })),
      });
      for (const p of providers) {
        setStatus(p.id, "testing");
        invokeCommand({ type: "llm_test_provider", baseUrl: p.baseUrl, apiKey: p.apiKey }).then(
          (result) => setStatus(p.id, result.success ? "ok" : "error"),
        );
      }
    },
  },
  snapshot: () => ({ providers: useLlmProviderStore.getState().providers }),
};

const figma: CloudCapability = {
  name: "figma",
  // No push: figma config reaches the runtime through the Figma node's Host
  // Adapter `prepareData` patch in `buildFlowUpdate`, not a sync command.
  snapshot: () => ({ figma: { uniqueId: useFigmaStore.getState().uniqueId } }),
};

export const CLOUD_CAPABILITIES: readonly CloudCapability[] = [mqtt, llm, figma];

/** `HostSnapshotProvider` for the `FlowUpdateDispatcher`, assembled from the
 * same registry that drives the sync. */
export function readHostSnapshot(): HostSnapshot {
  return assembleHostSnapshot(CLOUD_CAPABILITIES);
}

/** Mount the config→runtime sync driver for every cloud capability. Desktop
 * only — the browser resolves cloud config live from the stores (CloudDeps). */
export function useCloudCapabilitySync(): void {
  useEffect(() => {
    if (!isDesktop()) return;
    return startCloudCapabilitySync(CLOUD_CAPABILITIES);
  }, []);
}
