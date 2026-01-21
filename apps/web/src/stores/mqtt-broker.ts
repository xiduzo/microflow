import { create } from "zustand";
import { persist } from "zustand/middleware";

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
  addBroker: (broker: Omit<MqttBrokerConfig, "id">) => string;
  updateBroker: (id: string, broker: Partial<Omit<MqttBrokerConfig, "id">>) => void;
  deleteBroker: (id: string) => void;
  setDefaultBroker: (id: string) => void;
  getDefaultBroker: () => MqttBrokerConfig | undefined;
  getBroker: (id: string) => MqttBrokerConfig | undefined;
};

const uid = () => Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

export const useMqttBrokerStore = create<MqttBrokerStore>()(
  persist(
    (set, get) => ({
      brokers: [],

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
          return { brokers: filtered };
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
    }),
    {
      name: "microflow-mqtt-brokers",
    }
  )
);
