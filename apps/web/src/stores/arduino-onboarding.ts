import { create } from "zustand";
import { persist } from "zustand/middleware";

import { splitFromLegacyApp } from "./legacy-app-store";

/** The celebration of a user's first Arduino connection. */
type ArduinoOnboardingState = {
  hasConnectedArduino: boolean;
  showConfetti: boolean;
  markArduinoConnected: () => void;
  dismissConfetti: () => void;
};

export const useArduinoOnboardingStore = create<ArduinoOnboardingState>()(
  persist(
    (set) => ({
      hasConnectedArduino: false,
      showConfetti: false,
      markArduinoConnected: () => set({ hasConnectedArduino: true, showConfetti: true }),
      dismissConfetti: () => set({ showConfetti: false }),
    }),
    {
      name: "microflow:arduino-onboarding",
      storage: splitFromLegacyApp(["hasConnectedArduino"]),
      partialize: (state) => ({ hasConnectedArduino: state.hasConnectedArduino }),
    },
  ),
);
