// The browser side of export and import: a download, a file picker, toasts.
// What a flow file is lives in `flow-file.ts`, what an import decides in
// `import-flow.ts`, and where an imported flow lands in `open-flow.ts`.

import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { FlowData, FlowMeta } from "@microflow/collab";

import { useFlowSession } from "@/session";
import { track } from "@/lib/analytics";
import { reportError } from "@/lib/report-error";
import { trpc } from "@/lib/trpc";
import { randomFlowColor } from "./flow-colors";
import { encodeFlowFile } from "./flow-file";
import { importFlowFile } from "./import-flow";
import { useOpenFlow } from "./use-open-flow";

/** Download a flow as a flow file (works without an active flow document). */
export function exportFlowData(
  meta: Pick<FlowMeta, "name"> & Partial<FlowMeta>,
  data: FlowData
): void {
  const blob = new Blob([encodeFlowFile(meta, data)], {
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

/** Export the flow of the current session, from inside the editor. */
export function useFlowImportExport() {
  const { doc } = useFlowSession();

  const exportFlow = useCallback(() => {
    try {
      const data = doc.getFlowData();
      exportFlowData(doc.getMeta(), data);
      track("flow_exported", {
        nodes: data.nodes.length,
        edges: data.edges.length,
      });
      toast.success("Flow exported");
    } catch (error) {
      console.error("[FLOW-EXPORT] Error:", error);
      toast.error("Failed to export flow");
    }
  }, [doc]);

  return { exportFlow };
}

/**
 * Import a flow file from the My Flows overview. The returned function opens a
 * file picker and imports the chosen file (`importFlowFile`): the flow opens in
 * the account when signed in, otherwise it replaces the local flow, and the
 * user is told how it went.
 *
 * `route` is the calling route's id, for error reports.
 */
export function useImportFlow(route: string): () => void {
  const openFlow = useOpenFlow();
  const queryClient = useQueryClient();
  const { mutateAsync: createFromImport } = useMutation(
    trpc.flow.createFromImport.mutationOptions()
  );

  return useCallback(() => {
    pickFile(".json", async (file) => {
      const report = await importFlowFile(file, {
        open: openFlow,
        createInAccount: (flow) =>
          createFromImport({ ...flow, color: randomFlowColor() }),
      });

      if (report.failure !== undefined) {
        reportError(report.failure, { source: "action", route });
      }
      for (const { level, title, description } of report.messages) {
        // Everything from the file is shown as text. What the import found in
        // it stays up until it is closed.
        toast[level](title, {
          description,
          ...(level === "warning" ? NOTICES_TOAST : {}),
        });
      }
      if (report.imported) {
        if (report.imported.where === "account") {
          queryClient.invalidateQueries({ queryKey: trpc.flow.list.queryKey() });
        }
        track("flow_imported", {
          via: "overview",
          nodes: report.imported.nodes,
          edges: report.imported.edges,
        });
      }
    }).catch((error) => {
      reportError(error, { source: "action", route });
      toast.error("Failed to import flow", {
        description: error instanceof Error ? error.message : undefined,
      });
    });
  }, [openFlow, createFromImport, queryClient, route]);
}

const NOTICES_TOAST = {
  descriptionClassName: "whitespace-pre-line max-h-60 overflow-y-auto",
  duration: Infinity,
  closeButton: true,
};

/**
 * Open a file picker and hand the chosen file to `onFile`. Resolves when
 * `onFile` has; never when the picker is dismissed.
 */
function pickFile(
  accept: string,
  onFile: (file: File) => Promise<void>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      onFile(file).then(resolve, reject);
    };
    input.click();
  });
}
