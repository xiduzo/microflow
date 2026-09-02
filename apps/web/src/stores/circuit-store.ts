import { create } from "zustand";
import type { CircuitWebWorker } from "@tscircuit/eval";
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

  /**
   * Hardware nodes in the flow that the schematic has no part for, by instance
   * name. Rendered as a note beside the drawing so a missing part reads as a
   * known gap rather than as the node having been ignored.
   */
  unsupported: string[];

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
    const { createCircuitWebWorker } = await import("@tscircuit/eval");
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
    unsupported: [],

    buildCircuit: async (nodes, pins) => {
      set({ isPending: true, error: null });

      const { code, componentCount, unsupported } = buildCircuitCode(nodes, pins);
      set({ unsupported });

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
      set({ isPending: false, error: null, data: [], unsupported: [] });
    },
  };
});
