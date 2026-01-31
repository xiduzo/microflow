import { create } from "zustand";
import { createCircuitWebWorker, type CircuitWebWorker } from "@tscircuit/eval";
import type { AnyCircuitElement } from "circuit-json";
import type { Node } from "@xyflow/react";
import type { Pin } from "@/stores/board";
import { buildCircuitCode } from "@/lib/schematic/circuit-builder";

// ============================================================================
// Types
// ============================================================================

export type CircuitState = {
  isPending: boolean;
  error: string | null;
  data: AnyCircuitElement[];

  /** Build circuit from flow nodes and board pins. Worker is created on first call. */
  buildCircuit: (nodes: Node[], pins: Pin[]) => Promise<void>;

  /** Reset state (e.g. when leaving flow). Does not destroy the worker. */
  reset: () => void;
};

// ============================================================================
// Store
// ============================================================================

export const useCircuitStore = create<CircuitState>()((set, get) => {
  let worker: CircuitWebWorker | null = null;

  async function getWorker(): Promise<CircuitWebWorker> {
    if (worker) return worker;
    worker = await createCircuitWebWorker({
      projectConfig: {
        pcbDisabled: true,
        partsEngineDisabled: true,
        projectName: "Microflow circuit",
      },
    });
    return worker;
  }

  return {
    isPending: false,
    error: null,
    data: [],

    buildCircuit: async (nodes, pins) => {
      set({ isPending: true, error: null });

      const { code, componentCount } = buildCircuitCode(nodes, pins);

      if (!componentCount) {
        set({ isPending: false, error: null, data: [] });
        return;
      }

      try {
        const w = await getWorker();
        await w.execute(code);
        await w.renderUntilSettled();
        const json = await w.getCircuitJson();
        if (json) {
          set({ isPending: false, error: null, data: json });
        } else {
          set({ isPending: false, error: null, data: [] });
        }
      } catch (e) {
        console.error("[CIRCUIT-STORE] Build error:", e);
        set({
          isPending: false,
          error: e instanceof Error ? e.message : "Failed to render circuit",
          data: [],
        });
      }
    },

    reset: () => {
      set({ isPending: false, error: null, data: [] });
    },
  };
});
