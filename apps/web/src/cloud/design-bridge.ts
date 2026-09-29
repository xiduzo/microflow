import { create } from "zustand";
import { persist } from "zustand/middleware";
import { listen } from "@tauri-apps/api/event";
import {
  type BridgeVariable,
  type DesignTool,
  DESIGN_TOOLS,
  bridgeIdFromName,
  isValidBridgeId,
  parseTopic,
  randomBridgeId,
} from "@microflow/design-bridge";
import { type MqttMessagePayload } from "@/platform/ipc";
import { isDesktop } from "@/platform/platform";

export type { BridgeVariable, DesignTool };
export { DESIGN_TOOLS };

const isDesignTool = (client: string): client is DesignTool =>
  (DESIGN_TOOLS as readonly string[]).includes(client);

const perTool = <T>(value: () => T) =>
  Object.fromEntries(DESIGN_TOOLS.map((tool) => [tool, value()])) as Record<DesignTool, T>;

type DesignBridgeStore = {
  /** A Bridge ID the user typed; `null` means derive one. Persisted. */
  customBridgeId: string | null;
  /** A random Bridge ID for this device, used when there is no usable account name. Persisted. */
  deviceBridgeId: string;
  /** The signed-in account's display name. */
  accountName: string | null;
  variables: Record<DesignTool, Record<string, BridgeVariable>>;
  connected: Record<DesignTool, boolean>;
  setCustomBridgeId: (id: string | null) => void;
  setAccountName: (name: string | null) => void;
  /** Apply one inbound display message (a tool's variable list or status),
   *  filtering by the current Bridge ID. The desktop calls it from the Tauri
   *  "mqtt-message" event; the browser from the flow reactor's WSS feed. */
  ingestMqttMessage: (topic: string, payload: string) => void;
};

/** The Bridge ID pairing Studio with the design-tool plugins. */
export function bridgeIdOf(
  state: Pick<DesignBridgeStore, "customBridgeId" | "deviceBridgeId" | "accountName">,
): string {
  return (
    state.customBridgeId ??
    (state.accountName ? bridgeIdFromName(state.accountName) : null) ??
    state.deviceBridgeId
  );
}

export const useDesignBridgeStore = create<DesignBridgeStore>()(
  persist(
    (set, get) => ({
      customBridgeId: null,
      deviceBridgeId: randomBridgeId(),
      accountName: null,
      variables: perTool(() => ({})),
      connected: perTool(() => false),
      setCustomBridgeId: (id) => {
        const next = id?.trim() || null;
        if (next !== null && !isValidBridgeId(next)) return;
        if (next === get().customBridgeId) return;
        // A new Bridge ID means different topics: forget the old tools' state.
        set({ customBridgeId: next, variables: perTool(() => ({})), connected: perTool(() => false) });
      },
      setAccountName: (accountName) => set({ accountName }),
      ingestMqttMessage: (topic, payload) => {
        const parsed = parseTopic(topic);
        if (!parsed || parsed.uid !== bridgeIdOf(get()) || !isDesignTool(parsed.client)) return;
        const tool = parsed.client;
        if (parsed.kind === "variables") {
          try {
            const list = JSON.parse(payload) as Record<string, BridgeVariable>;
            set((s) => ({ variables: { ...s.variables, [tool]: list } }));
          } catch {
            /* ignore malformed JSON */
          }
          return;
        }
        if (parsed.kind === "status") {
          set((s) => ({ connected: { ...s.connected, [tool]: payload === "connected" } }));
        }
      },
    }),
    {
      name: "design-bridge",
      partialize: ({ customBridgeId, deviceBridgeId }) => ({ customBridgeId, deviceBridgeId }),
    },
  ),
);

// ---- Passive listener for MQTT messages emitted by the Rust runtime ----
// The desktop runtime handles all subscriptions and emits the Tauri
// "mqtt-message" event; the browser feeds `ingestMqttMessage` from the flow
// reactor instead (see board-controller). Both land in the same store.
if (isDesktop()) {
  listen<MqttMessagePayload>("mqtt-message", (event) => {
    useDesignBridgeStore.getState().ingestMqttMessage(event.payload.topic, event.payload.payload);
  });
}

// ---- Public hooks ----
export function useBridgeId(): string {
  return useDesignBridgeStore(bridgeIdOf);
}

export function useDesignVariables() {
  return useDesignBridgeStore((s) => s.variables);
}

export function useDesignVariable(source: DesignTool, variableId?: string) {
  const variable = useDesignBridgeStore((s) =>
    variableId ? s.variables[source]?.[variableId] : undefined,
  );
  return { variable };
}

export function useDesignToolsConnected() {
  return useDesignBridgeStore((s) => s.connected);
}
