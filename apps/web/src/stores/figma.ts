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
};

export const useFigmaStore = create<FigmaStore>((set) => ({
  variables: {},
  pluginConnected: false,
  uniqueId: "anonymous",
  setVariables: (variables) => set({ variables }),
  setPluginConnected: (pluginConnected) => set({ pluginConnected }),
  setUniqueId: (uniqueId) => set({ uniqueId }),
}));

// ---- Passive listener for MQTT messages emitted by the Rust runtime ----
// The runtime handles all subscriptions/unsubscriptions. The frontend just
// listens for the Tauri "mqtt-message" event and updates the store when
// it sees Figma display topics (variables list, plugin status).
if (isDesktop()) {
  listen<MqttMessagePayload>("mqtt-message", (event) => {
    const { topic, payload } = event.payload;
    const { uniqueId, setVariables, setPluginConnected } = useFigmaStore.getState();

    if (
      topic === `microflow/${uniqueId}/figma/variables` ||
      topic === `microflow/${uniqueId}/app/variables/response`
    ) {
      try {
        setVariables(JSON.parse(payload) as Record<string, PickedVariable>);
      } catch { /* ignore malformed JSON */ }
      return;
    }

    if (topic === `microflow/${uniqueId}/figma/status`) {
      setPluginConnected(payload === "connected");
    }
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
