import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export type MqttBrokerConfig = {
  id: string;
  name: string;
  url: string;
  username?: string;
  password?: string;
  isDefault: boolean;
};

type MqttBrokerStore = {
  brokers: MqttBrokerConfig[];
  /** Connection status per broker ID (managed separately from persisted config) */
  statuses: Record<string, ConnectionStatus>;
  addBroker: (broker: Omit<MqttBrokerConfig, "id">) => string;
  updateBroker: (id: string, broker: Partial<Omit<MqttBrokerConfig, "id">>) => void;
  deleteBroker: (id: string) => void;
  setDefaultBroker: (id: string) => void;
  getDefaultBroker: () => MqttBrokerConfig | undefined;
  getBroker: (id: string) => MqttBrokerConfig | undefined;
  setStatus: (id: string, status: ConnectionStatus) => void;
  setStatuses: (statuses: Record<string, ConnectionStatus>) => void;
};

const uid = () => Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

export const useMqttBrokerStore = create<MqttBrokerStore>()(
  persist(
    (set, get) => ({
      brokers: [],
      statuses: {},

      addBroker: (broker) => {
        const id = uid();
        const isFirst = get().brokers.length === 0;
        set((state) => ({
          brokers: [
            ...state.brokers,
            { ...broker, id, isDefault: isFirst || broker.isDefault },
          ],
        }));
        return id;
      },

      updateBroker: (id, updates) => {
        set((state) => ({
          brokers: state.brokers.map((b) =>
            b.id === id ? { ...b, ...updates } : b
          ),
        }));
      },

      deleteBroker: (id) => {
        set((state) => {
          const filtered = state.brokers.filter((b) => b.id !== id);
          // If we deleted the default, make the first one default
          if (filtered.length > 0 && !filtered.some((b) => b.isDefault)) {
            filtered[0].isDefault = true;
          }
          // Also remove status
          const { [id]: _, ...remainingStatuses } = state.statuses;
          return { brokers: filtered, statuses: remainingStatuses };
        });
      },

      setDefaultBroker: (id) => {
        set((state) => ({
          brokers: state.brokers.map((b) => ({
            ...b,
            isDefault: b.id === id,
          })),
        }));
      },

      getDefaultBroker: () => {
        return get().brokers.find((b) => b.isDefault);
      },

      getBroker: (id) => {
        return get().brokers.find((b) => b.id === id);
      },

      setStatus: (id, status) => {
        set((state) => ({
          statuses: { ...state.statuses, [id]: status },
        }));
      },

      setStatuses: (statuses) => {
        set({ statuses });
      },
    }),
    {
      name: "microflow-mqtt-brokers",
      partialize: (state) => ({ brokers: state.brokers }), // Only persist brokers, not statuses
    }
  )
);
