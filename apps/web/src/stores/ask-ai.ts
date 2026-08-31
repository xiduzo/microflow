import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { WriteMode } from "@/lib/ai/flow-tools";

export type { WriteMode };

/** What each write mode does, shown next to the picker so the choice is made
 *  once and understood rather than guessed at every turn. */
export const WRITE_MODES: ReadonlyArray<{
  value: WriteMode;
  label: string;
  hint: string;
}> = [
  { value: "auto", label: "Auto", hint: "Changes are applied as they are made." },
  { value: "confirm", label: "Confirm", hint: "Changes are shown for you to accept first." },
  { value: "read-only", label: "Read only", hint: "Can look and explain, never edits." },
];

type AskAiStore = {
  open: boolean;
  /** How the assistant's edits reach the flow. Persisted: it is a standing
   *  preference about trust, not a per-conversation choice. */
  writeMode: WriteMode;
  /** Which saved LLM configuration (Configuration → LLM) answers. Empty means
   *  "the default one", so a fresh install works without a choice being made. */
  providerId: string;
  /** Node ids currently selected on the canvas. Not persisted: it is where the
   *  user is looking right now, and it scopes the flow context Ask AI is given
   *  so "wire these two up" means the two that are highlighted. */
  selectedNodeIds: string[];
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setWriteMode: (mode: WriteMode) => void;
  setProviderId: (providerId: string) => void;
  setSelectedNodeIds: (selectedNodeIds: string[]) => void;
};

export const useAskAiStore = create<AskAiStore>()(
  persist(
    (set) => ({
      open: false,
      writeMode: "auto",
      providerId: "",
      selectedNodeIds: [],
      setOpen: (open) => set({ open }),
      toggle: () => set((s) => ({ open: !s.open })),
      setWriteMode: (writeMode) => set({ writeMode }),
      setProviderId: (providerId) => set({ providerId }),
      setSelectedNodeIds: (selectedNodeIds) => set({ selectedNodeIds }),
    }),
    {
      name: "microflow-ask-ai",
      // `open` is deliberately not persisted: the panel should not reappear on a
      // flow you opened to look at.
      partialize: (s) => ({
        writeMode: s.writeMode,
        providerId: s.providerId,
      }),
    },
  ),
);
