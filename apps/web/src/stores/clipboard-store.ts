import { create } from "zustand";
import { toast } from "sonner";
import type { FlowDocument, FlowNode } from "@microflow/collab";
import type { XYPosition } from "@xyflow/react";

const uid = () => Math.random().toString(36).substring(2, 9);

type ClipboardState = {
  copiedNodes: FlowNode[];
  copy: (nodes: FlowNode[]) => void;
  paste: (doc: FlowDocument, cursorPosition: XYPosition) => void;
  clear: () => void;
};

export const useClipboardStore = create<ClipboardState>((set, get) => ({
  copiedNodes: [],

  copy: (nodes) => {
    if (nodes.length === 0) {
      toast.info("No nodes selected");
      return;
    }
    set({ copiedNodes: nodes });
    toast.success(`Copied ${nodes.length} node(s)`);
  },

  paste: (doc, cursorPosition) => {
    const { copiedNodes } = get();
    if (copiedNodes.length === 0) return;

    const nodeCount = copiedNodes.length;
    const { sumX, sumY } = copiedNodes.reduce(
      (acc, node) => ({
        sumX: acc.sumX + node.position.x + (node.width ?? 100) / 2,
        sumY: acc.sumY + node.position.y + (node.height ?? 50) / 2,
      }),
      { sumX: 0, sumY: 0 },
    );

    const offsetX = cursorPosition.x - sumX / nodeCount;
    const offsetY = cursorPosition.y - sumY / nodeCount;

    doc.doc.transact(() => {
      for (const node of copiedNodes) {
        const newNode: FlowNode = {
          ...node,
          id: uid(),
          position: {
            x: node.position.x + offsetX,
            y: node.position.y + offsetY,
          },
          selected: false,
        };
        doc.nodes.set(newNode.id, newNode);
      }
    }, "local");

    toast.success(`Pasted ${copiedNodes.length} node(s)`);
  },

  clear: () => set({ copiedNodes: [] }),
}));
