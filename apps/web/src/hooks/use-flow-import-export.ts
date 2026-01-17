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

export function useFlowImportExport() {
  const flowDoc = useFlowDocument();

  const exportFlow = useCallback(() => {
    if (!flowDoc) {
      toast.error("No flow to export");
      return;
    }

    try {
      const meta = flowDoc.getMeta();
      const data = flowDoc.getFlowData();

      const exportData: FlowExportData = {
        meta,
        data,
        version: meta.version ?? EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
      };

      // Create blob and download
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
