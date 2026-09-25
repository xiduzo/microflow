import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { type MqttMessagePayload } from "@/lib/ipc";
import { isDesktop } from "@/lib/platform";
import { authClient } from "@/lib/auth-client";

type PickedVariable = {
  id: string;
  name: string;
  resolvedType: "FLOAT" | "STRING" | "BOOLEAN" | "COLOR";
};

// ---- Variable and connection state ----
type FigmaStore = {
  variables: Record<string, PickedVariable>;
  pluginConnected: boolean;
  uniqueId: string;
  setVariables: (vars: Record<string, PickedVariable>) => void;
  setPluginConnected: (connected: boolean) => void;
  setUniqueId: (id: string) => void;
  /** Apply one inbound Figma display message (variables list / plugin status),
   *  filtering by the current uid. Platform-agnostic: the desktop calls it from
   *  the Tauri "mqtt-message" event; the browser calls it from the flow
   *  reactor's WSS message feed. */
  ingestMqttMessage: (topic: string, payload: string) => void;
};

export const useFigmaStore = create<FigmaStore>((set, get) => ({
  variables: {},
  pluginConnected: false,
  uniqueId: "anonymous",
  setVariables: (variables) => set({ variables }),
  setPluginConnected: (pluginConnected) => set({ pluginConnected }),
  setUniqueId: (uniqueId) => set({ uniqueId }),
  ingestMqttMessage: (topic, payload) => {
    const { uniqueId } = get();
    if (
      topic === `microflow/${uniqueId}/figma/variables` ||
      topic === `microflow/${uniqueId}/app/variables/response`
    ) {
      try {
        set({ variables: JSON.parse(payload) as Record<string, PickedVariable> });
      } catch { /* ignore malformed JSON */ }
      return;
    }
    if (topic === `microflow/${uniqueId}/figma/status`) {
      set({ pluginConnected: payload === "connected" });
    }
  },
}));

// ---- Passive listener for MQTT messages emitted by the Rust runtime ----
// The desktop runtime handles all subscriptions and emits the Tauri
// "mqtt-message" event; the browser feeds `ingestMqttMessage` from the flow
// reactor instead (see board-controller). Both land in the same store.
if (isDesktop()) {
  listen<MqttMessagePayload>("mqtt-message", (event) => {
    useFigmaStore.getState().ingestMqttMessage(event.payload.topic, event.payload.payload);
  });
}

// ---- Public hooks ----
export function useFigmaVariables() {
  return useFigmaStore((s) => s.variables);
}

export function useFigmaVariable(variableId?: string) {
  const variable = useFigmaStore((s) =>
    variableId ? s.variables[variableId] : undefined,
  );
  return { variable };
}

export function useFigmaPluginConnected() {
  return useFigmaStore((s) => s.pluginConnected);
}

function useUniqueId() {
  const { data: session } = authClient.useSession();
  return session?.user?.name ?? "anonymous";
}

export { useUniqueId as useFigmaUniqueId };
