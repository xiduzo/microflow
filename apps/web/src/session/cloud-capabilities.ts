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
import { probeBroker, probeLlmProvider, probeStatus } from "./browser-cloud-probe";
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

// Identical in both hosts since ADR-0021: there is nothing to sync *to* any
// more — the webview performs every generation and resolves `providerId` from
// this store at request time, on desktop as in the browser. All that is left is
// the status dot, filled by the probe that runs the same transport.
const llm: CloudCapability = {
  name: "llm",
  sync: {
    read: () => useLlmProviderStore.getState().providers,
    subscribe: (onChange) => useLlmProviderStore.subscribe(onChange),
    push: () => {
      const { providers, setStatus } = useLlmProviderStore.getState();
      for (const provider of providers) {
        setStatus(provider.id, "testing");
        // Only the dot is drawn here; the reason is rendered on the config page.
        void probeLlmProvider(provider).then((outcome) =>
          setStatus(provider.id, probeStatus(outcome)),
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

// The browser has no host to sync config *to* — the CloudPerformer resolves it
// live from these same stores. What it lacks is the desktop's status feedback,
// so its "push" is a reachability probe that fills the status dots instead.
const browserMqtt: CloudCapability = {
  ...mqtt,
  listen: undefined,
  sync: {
    read: mqtt.sync!.read,
    subscribe: mqtt.sync!.subscribe,
    push: () => {
      const { brokers, setStatus } = useMqttBrokerStore.getState();
      for (const broker of brokers) {
        setStatus(broker.id, "connecting");
        void probeBroker(broker).then((status) => setStatus(broker.id, status));
      }
    },
  },
};

export const BROWSER_CLOUD_CAPABILITIES: readonly CloudCapability[] = [browserMqtt, llm, figma];

/** `HostSnapshotProvider` for the `FlowUpdateDispatcher`, assembled from the
 * same registry that drives the sync. */
export function readHostSnapshot(): HostSnapshot {
  return assembleHostSnapshot(CLOUD_CAPABILITIES);
}

/** Mount the cloud-capability driver: on desktop it syncs config to the native
 * host and listens for its status events; in the browser (which resolves config
 * live from the stores via `CloudDeps`) it probes each endpoint for reachability
 * so the config pages show a real status instead of a permanent "disconnected". */
export function useCloudCapabilitySync(): void {
  useEffect(
    () =>
      startCloudCapabilitySync(isDesktop() ? CLOUD_CAPABILITIES : BROWSER_CLOUD_CAPABILITIES),
    [],
  );
}
