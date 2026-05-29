import { useEffect, useState } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTheme } from "@/providers/theme-provider";
import { useFlowSession, useFlowNodes, useFlowEdges } from "@/session";
import { invokeCommand } from "@/lib/ipc";
import {
  projectSketchResult,
  type SketchInvoker,
  type SketchResponse,
} from "./sketch-code-view.model";

// Use local bundle + workers instead of CDN (required for offline Tauri).
// Mirrors the Function code editor setup; the read-only view only needs the
// base editor worker (no language services).
(window as Window & { MonacoEnvironment?: unknown }).MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};
loader.config({ monaco });

const invoke: SketchInvoker = (command) => invokeCommand(command) as Promise<SketchResponse>;

/**
 * Read-only Monaco view of the Arduino sketch generated from the current Flow.
 *
 * Generates once on open (Task #45); live regeneration on graph edits is Task 4.
 * The editor is always read-only — the Author can read and copy but not edit.
 */
export function SketchCodeView({ onClose }: { onClose: () => void }) {
  const { theme } = useTheme();
  const { doc } = useFlowSession();
  const nodes = useFlowNodes(doc);
  const edges = useFlowEdges(doc);
  const [value, setValue] = useState("// Generating sketch…");

  useEffect(() => {
    let cancelled = false;
    void projectSketchResult(
      invoke,
      nodes as Parameters<typeof projectSketchResult>[1],
      edges as Parameters<typeof projectSketchResult>[2],
    ).then((state) => {
      if (!cancelled) setValue(state.value);
    });
    return () => {
      cancelled = true;
    };
    // Generate on open only; the node/edge snapshot is read once (Task 4 adds
    // debounced live regeneration).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Dialog defaultOpen onOpenChange={onClose}>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] p-0 gap-0 overflow-hidden flex flex-col">
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0">
          <DialogTitle>Generated sketch</DialogTitle>
        </DialogHeader>
        <div className="flex-1 h-[60vh] border-y">
          <Editor
            height="100%"
            language="cpp"
            value={value}
            theme={theme === "dark" ? "vs-dark" : "light"}
            options={{
              readOnly: true,
              domReadOnly: true,
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: "on",
              tabSize: 2,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: "on",
              padding: { top: 12, bottom: 12 },
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
