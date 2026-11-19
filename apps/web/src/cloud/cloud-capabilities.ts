import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  resolveStoredBroker,
  settleBrokerSettings,
  useMqttBrokerStore,
  type ConnectionStatus,
  type MqttBrokerConfig,
} from "@/cloud/mqtt-broker";
import { reachesDifferently, useLlmProviderStore, type LlmProviderConfig } from "@/ai/llm-provider";
import { bridgeIdOf, useDesignBridgeStore } from "@/cloud/design-bridge";
import { invokeCommand, type BrokerStatusPayload } from "@/platform/ipc";
import type { BrokerStatuses } from "@/lib/bindings/BrokerStatuses";
import { isDesktop } from "@/platform/platform";
import {
  assembleHostSnapshot,
  startCloudCapabilitySync,
  watchHostSnapshot,
  type CloudCapability,
} from "./cloud-capability-sync";
import {
  probeBroker,
  probeLlmProvider,
  probeStatus,
  type BrokerProbe,
  type LlmProbeOutcome,
} from "./browser-cloud-probe";
import type { HostSnapshot } from "@/runtime/flow-update-dispatcher";

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

/** The problems the host gave, by broker id: the brokers it gave none for
 *  have none. */
function toProblemMap(statuses: BrokerStatusPayload[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const status of statuses) {
    if (status.problem !== null) map[status.id] = status.problem;
  }
  return map;
}

/**
 * The status dots of the desktop's brokers, and why a broker is in error when
 * the host knows, from the snapshots the host sends two ways — the answer to
 * `mqtt_sync_brokers` and the `mqtt-broker-status` event — which arrive in
 * either order: a fast broker is connected before the answer that says it is
 * connecting gets here. Every snapshot carries a number, higher for a later
 * state; one older than the newest applied is dropped. Returns what to hand
 * each snapshot to.
 */
export function brokerStatusFeed(
  setStatuses: (statuses: Record<string, ConnectionStatus>, problems: Record<string, string>) => void,
): (snapshot: BrokerStatuses) => void {
  let newest = -1;
  return (snapshot) => {
    if (snapshot.seq < newest) return;
    newest = snapshot.seq;
    setStatuses(toStatusMap(snapshot.brokers), toProblemMap(snapshot.brokers));
  };
}

/** What the desktop broker capability asks of the host. */
export type DesktopBrokerIpc = {
  /** Listen to the status event; resolves to the unlisten once listening. */
  listen(onSnapshot: (snapshot: BrokerStatuses) => void): Promise<() => void>;
  /** Send the broker list; resolves to the host's answer, if it gave one. */
  sync(brokers: MqttBrokerConfig[]): Promise<BrokerStatuses | undefined>;
};

const tauriBrokerIpc: DesktopBrokerIpc = {
  listen: (onSnapshot) =>
    listen<BrokerStatuses>("mqtt-broker-status", (event) => onSnapshot(event.payload)),
  sync: async (brokers) => {
    const result = await invokeCommand<
      { type: "mqtt_sync_brokers"; brokers: MqttBrokerConfig[] },
      { data?: BrokerStatuses }
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
    return result.success ? (result.data as unknown as BrokerStatuses | undefined) : undefined;
  },
};

/**
 * The desktop's broker capability over `ipc`. The slice is the settled broker
 * settings (`mqtt-broker.ts`): a URL that is being typed is not in it, so the
 * host is sent the list once the typing has stopped, and at once when a
 * broker is added or removed. The status event is listened to before the
 * first list is sent, and the dots follow the newest snapshot
 * ({@link brokerStatusFeed}).
 */
export function desktopBrokerCapability(ipc: DesktopBrokerIpc): CloudCapability {
  const show = brokerStatusFeed((statuses, problems) =>
    useMqttBrokerStore.getState().setStatuses(statuses, problems),
  );
  return {
    name: "mqtt",
    sync: {
      read: () => useMqttBrokerStore.getState().brokers,
      subscribe: (onChange) => useMqttBrokerStore.subscribe(onChange),
      push: async () => {
        const answer = await ipc.sync(useMqttBrokerStore.getState().brokers);
        if (answer) show(answer);
      },
    },
    listen: () => ipc.listen(show),
    snapshot: () => ({ brokers: useMqttBrokerStore.getState().brokers }),
  };
}

const mqtt = desktopBrokerCapability(tauriBrokerIpc);

// Identical in both hosts since ADR-0021: there is nothing to sync *to* any
// more — the webview performs every generation and resolves `providerId` from
// this store at request time, on desktop as in the browser. All that is left is
// the status dot, filled by the probe that runs the same transport. The slice is
// the settled provider settings: a key that is being typed is not sent to the
// provider a keystroke at a time.
const llm: CloudCapability = {
  name: "llm",
  sync: {
    read: () => useLlmProviderStore.getState().settled,
    subscribe: (onChange) => useLlmProviderStore.subscribe(onChange),
    push: () => probeLlmStatuses(),
  },
  snapshot: () => ({ providers: useLlmProviderStore.getState().providers }),
};

/**
 * Probe every LLM provider, as its settings settled, and show the answer as
 * its status dot, `testing` until it is in. Only the dot is drawn here; the
 * reason is rendered on the config page.
 *
 * An answer is for the settings that were probed: one that arrives after the
 * provider's endpoint or key settled to something else, or after the provider
 * was removed, is dropped.
 *
 * `probe` is {@link probeLlmProvider}; a test passes its own.
 */
export function probeLlmStatuses(
  probe: (provider: LlmProviderConfig) => Promise<LlmProbeOutcome> = probeLlmProvider,
): void {
  const { settled, setStatus } = useLlmProviderStore.getState();
  for (const provider of settled) {
    setStatus(provider.id, "testing");
    void probe(provider).then((outcome) => {
      const now = useLlmProviderStore.getState().settled.find((each) => each.id === provider.id);
      if (now !== undefined && !reachesDifferently(provider, now)) setStatus(provider.id, probeStatus(outcome));
    });
  }
}

const figma: CloudCapability = {
  name: "figma",
  // No push: the Bridge ID reaches the runtime through the Figma node's Host
  // Adapter `prepareData` patch in `buildFlowUpdate`, not a sync command.
  snapshot: () => ({ figma: { uniqueId: bridgeIdOf(useDesignBridgeStore.getState()) } }),
  watchSnapshot: (onChange) => {
    let last = bridgeIdOf(useDesignBridgeStore.getState());
    return useDesignBridgeStore.subscribe((state) => {
      const next = bridgeIdOf(state);
      if (next === last) return;
      last = next;
      onChange();
    });
  },
};

export const CLOUD_CAPABILITIES: readonly CloudCapability[] = [mqtt, llm, figma];

/**
 * Probe every broker for reachability from this browser and show the answer
 * as its status dot, `connecting` until it is in.
 *
 * An answer is for the settings that were probed. One that arrives after the
 * broker's settings changed again, or after the broker was removed, is
 * dropped: a probe of a broker that is not there takes seconds to give up,
 * and its `error` would land on the dot of the URL that was typed since.
 *
 * `probe` is {@link probeBroker}; a test passes its own.
 */
export function probeBrokerStatuses(
  probe: (broker: MqttBrokerConfig) => Promise<BrokerProbe> = probeBroker,
): void {
  const { brokers, setStatus } = useMqttBrokerStore.getState();
  for (const broker of brokers) {
    setStatus(broker.id, "connecting");
    void probe(broker).then(({ status, problem }) => {
      const now = resolveStoredBroker(broker.id);
      const asProbed =
        now !== undefined &&
        now.url === broker.url &&
        now.username === broker.username &&
        now.password === broker.password;
      if (asProbed) setStatus(broker.id, status, problem);
    });
  }
}

// The browser has no host to sync config *to* — the CloudPerformer resolves it
// live from these same stores, and watches the broker store itself
// (`onBrokerSettingsChange`). What it lacks is the desktop's status feedback,
// so its "push" is a reachability probe that fills the status dots instead.
const browserMqtt: CloudCapability = {
  ...mqtt,
  listen: undefined,
  sync: {
    read: mqtt.sync!.read,
    subscribe: mqtt.sync!.subscribe,
    push: () => probeBrokerStatuses(),
  },
};

export const BROWSER_CLOUD_CAPABILITIES: readonly CloudCapability[] = [browserMqtt, llm, figma];

/** The `HostSnapshot` as it is, assembled from the same registry that drives
 * the sync. Reading it changes nothing, so it is safe while rendering. */
export function readHostSnapshot(): HostSnapshot {
  return assembleHostSnapshot(CLOUD_CAPABILITIES);
}

/** `HostSnapshotProvider` for the `FlowUpdateDispatcher`: the `HostSnapshot` a
 * flow update is built from.
 *
 * A flow is sent with the broker settings the form shows: what is typed there
 * and has not settled is settled first, so a flow never starts on older
 * settings than the user sees. On the desktop that sends the host the broker
 * list ahead of the flow; in the browser the CloudPerformer has followed the
 * settings by the time the flow reaches it. With nothing typed this is
 * `readHostSnapshot`. */
export function hostSnapshotForFlowUpdate(): HostSnapshot {
  settleBrokerSettings();
  return readHostSnapshot();
}

/** Call `onChange` when the `HostSnapshot` changes (e.g. a new Bridge ID). */
export function onHostSnapshotChange(onChange: () => void): () => void {
  return watchHostSnapshot(CLOUD_CAPABILITIES, onChange);
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
