import { useCallback } from "react";
import { toast } from "sonner";
import { useFlowDocument } from "@/stores/flow-store";
import type { FlowData, FlowMeta } from "@microflow/collab";

export type FlowExportData = {
  meta: FlowMeta;
  data: FlowData;
  version: number;
  exportedAt: string;
};

const EXPORT_VERSION = 1;

/** Export flow data to a JSON file (works without an active flow document) */
export function exportFlowData(
  meta: Pick<FlowMeta, "name"> & Partial<FlowMeta>,
  data: FlowData
): void {
  const exportData: FlowExportData = {
    meta: {
      name: meta.name ?? "flow",
      description: meta.description,
      version: meta.version ?? EXPORT_VERSION,
      updatedAt: meta.updatedAt ?? Date.now(),
    },
    data,
    version: meta.version ?? EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${meta.name || "flow"}-${Date.now()}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function useFlowImportExport() {
  const flowDoc = useFlowDocument();

  const exportFlow = useCallback(() => {
    if (!flowDoc) {
      toast.error("No flow to export");
      return;
    }

    try {
      exportFlowData(flowDoc.getMeta(), flowDoc.getFlowData());
      toast.success("Flow exported");
    } catch (error) {
      console.error("[FLOW-EXPORT] Error:", error);
      toast.error("Failed to export flow");
    }
  }, [flowDoc]);

  const importFlow = useCallback(() => {
    if (!flowDoc) {
      toast.error("No active flow to import into");
      return;
    }

    try {
      // Create file input
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";

      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;

        try {
          const text = await file.text();
          const importData = JSON.parse(text) as FlowExportData;

          // Validate structure
          if (
            !importData.data ||
            !importData.data.nodes ||
            !importData.data.edges
          ) {
            throw new Error("Invalid flow file format");
          }

          // Import the flow data
          flowDoc.setFlowData(importData.data.nodes, importData.data.edges);

          // Update meta if available
          if (importData.meta) {
            flowDoc.setMeta({
              name: importData.meta.name,
              description: importData.meta.description,
            });
          }

          toast.success(`Flow imported`, {
            description: `${importData.data.nodes.length} nodes, ${importData.data.edges.length} edges`,
          });
        } catch (error) {
          console.error("[FLOW-IMPORT] Error:", error);
          toast.error("Failed to import flow", {
            description:
              error instanceof Error ? error.message : "Something went wrong",
          });
        }
      };

      input.click();
    } catch (error) {
      console.error("[FLOW-IMPORT] Error:", error);
      toast.error("Failed to import flow");
    }
  }, [flowDoc]);

  return {
    exportFlow,
    importFlow,
    canExport: !!flowDoc,
    canImport: !!flowDoc,
  };
}

export const LOCAL_FLOW_STORAGE_KEY = "microflow-local-flow";

/** Returns a function that opens a file picker and calls the given handler with parsed FlowExportData. For use on My Flows overview. */
export function useOverviewImport() {
  return useCallback(
    (onParsed: (data: FlowExportData) => void | Promise<void>) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";

      input.onchange = async (e: Event) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;

        try {
          const text = await file.text();
          const importData = JSON.parse(text) as FlowExportData;

          if (
            !importData.data ||
            !importData.data.nodes ||
            !importData.data.edges
          ) {
            throw new Error("Invalid flow file format");
          }

          await onParsed(importData);
        } catch (error) {
          console.error("[FLOW-IMPORT] Error:", error);
          toast.error("Failed to import flow", {
            description:
              error instanceof Error ? error.message : "Something went wrong",
          });
        }
      };

      input.click();
    },
    []
  );
}
