import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { invokeCommand, type MqttMessagePayload } from "@/lib/ipc";
import { useMqttBrokerStore } from "./mqtt-broker";
import { useCallback, useEffect } from "react";
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

// ---- Topic ref-counting to prevent duplicate Rust subscriptions ----
const topicRefs = new Map<string, number>();

async function subscribeToTopic(brokerId: string, topic: string) {
  const key = `${brokerId}:${topic}`;
  const count = topicRefs.get(key) ?? 0;
  if (count === 0) {
    await invokeCommand({ type: "mqtt_subscribe", brokerId, topic });
  }
  topicRefs.set(key, count + 1);
}

async function unsubscribeFromTopic(brokerId: string, topic: string) {
  const key = `${brokerId}:${topic}`;
  const count = topicRefs.get(key) ?? 0;
  if (count <= 1) {
    topicRefs.delete(key);
    await invokeCommand({ type: "mqtt_unsubscribe", brokerId, topic });
  } else {
    topicRefs.set(key, count - 1);
  }
}

function useUniqueId() {
  const { data: session } = authClient.useSession();
  return session?.user?.name ?? "anonymous";
}

// ---- React hook — subscribes to display-only topics (variables list + plugin status).
//      Runtime variable routing (individual values → flow) is handled by figma.rs. ----
export function useFigmaSync() {
  const uniqueId = useUniqueId();
  const brokerId = useMqttBrokerStore((s) => s.getDefaultBroker()?.id);

  useEffect(() => {
    useFigmaStore.getState().setUniqueId(uniqueId);
  }, [uniqueId]);

  useEffect(() => {
    if (!isDesktop() || !brokerId) return;

    let cancelled = false;

    // Only the topics the frontend needs: variables list + connection status
    const topics = [
      `microflow/${uniqueId}/figma/variables`,
      `microflow/${uniqueId}/figma/status`,
      `microflow/${uniqueId}/app/variables/response`,
    ];

    function requestVariables() {
      if (cancelled) return;
      invokeCommand({
        type: "mqtt_publish",
        brokerId: brokerId!,
        topic: `microflow/${uniqueId}/app/variables/request`,
        payload: "",
      });
    }

    Promise.all(topics.map((t) => subscribeToTopic(brokerId, t))).then(() => {
      requestVariables();
    });

    invokeCommand({
      type: "mqtt_publish",
      brokerId,
      topic: `microflow/${uniqueId}/app/status`,
      payload: "connected",
      retain: true,
    });

    // Re-request variables periodically until we have them.
    // The plugin may not be connected yet when we first subscribe,
    // and retained messages may not be available. Once we have
    // variables the interval is cheap (plugin deduplicates responses).
    const retryId = setInterval(() => {
      const { variables, pluginConnected } = useFigmaStore.getState();
      if (pluginConnected && Object.keys(variables).length > 0) return;
      requestVariables();
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(retryId);
      topics.forEach((t) => unsubscribeFromTopic(brokerId, t));
      invokeCommand({
        type: "mqtt_publish",
        brokerId,
        topic: `microflow/${uniqueId}/app/status`,
        payload: "disconnected",
        retain: true,
      });
    };
  }, [brokerId, uniqueId]);

  const handleMessage = useCallback(
    (event: { payload: MqttMessagePayload }) => {
      const { topic, payload } = event.payload;
      const { uniqueId: currentId } = useFigmaStore.getState();
      const { setVariables, setPluginConnected } = useFigmaStore.getState();

      if (
        topic === `microflow/${currentId}/figma/variables` ||
        topic === `microflow/${currentId}/app/variables/response`
      ) {
        try {
          setVariables(JSON.parse(payload) as Record<string, PickedVariable>);
        } catch {}
        return;
      }

      if (topic === `microflow/${currentId}/figma/status`) {
        setPluginConnected(payload === "connected");
      }
    },
    [],
  );

  useEffect(() => {
    if (!isDesktop()) return;
    const unlisten = listen<MqttMessagePayload>("mqtt-message", handleMessage);
    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
    };
  }, [handleMessage]);
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

export { useUniqueId as useFigmaUniqueId };
