import { useEffect, useRef, useState } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { Download } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/providers/theme-provider";
import { useFlowSession, useFlowNodes, useFlowEdges, useFlowMeta } from "@/session";
import { invokeCommand } from "@/lib/ipc";
import {
  buildSketchDownloadRequest,
  canDownloadSketch,
  createDebouncedRegenerator,
  GENERATING_SKETCH_PLACEHOLDER,
  projectSketchResult,
  serializeFlowGraph,
  type SketchDownloadHandler,
  type SketchInvoker,
  type SketchResponse,
  type SketchViewState,
} from "./sketch-code-view.model";
import { deriveSketchFilename } from "./sketch-download.model";
import { downloadSketch } from "./sketch-download";

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
 * Generates once on open (Task #45) and re-generates — debounced — whenever the
 * Flow graph changes while the view is open (Task #47). The editor is always
 * read-only — the Author can read and copy but not edit.
 */
/**
 * Default download handler (Task #31): persists the sketch to a `.ino` file via
 * the native save dialog on desktop, or an in-browser download on the web. The
 * platform seams live in `sketch-download.ts`; callers may inject a handler to
 * override (e.g. tests).
 */
const defaultDownload: SketchDownloadHandler = (request) => {
  void downloadSketch(request);
};

export function SketchCodeView({
  onClose,
  onDownload = defaultDownload,
}: {
  onClose: () => void;
  onDownload?: SketchDownloadHandler;
}) {
  const { theme } = useTheme();
  const { doc } = useFlowSession();
  const nodes = useFlowNodes(doc);
  const edges = useFlowEdges(doc);
  const meta = useFlowMeta(doc);
  const suggestedFilename = deriveSketchFilename(meta.name);
  const [state, setState] = useState<SketchViewState>({
    value: GENERATING_SKETCH_PLACEHOLDER,
    isError: false,
  });
  const { value } = state;

  type GenNode = Parameters<typeof projectSketchResult>[1][number];
  type GenEdge = Parameters<typeof projectSketchResult>[2][number];
  const genNodes = nodes as GenNode[];
  const genEdges = edges as GenEdge[];

  // Generate once on open, seeding the regenerator so an identical first edit
  // does not trigger a redundant regeneration.
  useEffect(() => {
    let cancelled = false;
    void projectSketchResult(invoke, genNodes, genEdges).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
    // Read the on-open snapshot once; live edits flow through the regenerator below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced live regeneration on Flow graph changes.
  const regeneratorRef = useRef<ReturnType<typeof createDebouncedRegenerator> | null>(null);
  if (regeneratorRef.current === null) {
    regeneratorRef.current = createDebouncedRegenerator({
      invoker: invoke,
      onResult: (next) => setState(next),
      seedSerialized: serializeFlowGraph(genNodes, genEdges),
    });
  }

  useEffect(() => {
    const regenerator = regeneratorRef.current;
    return () => regenerator?.cancel();
  }, []);

  useEffect(() => {
    regeneratorRef.current?.schedule(genNodes, genEdges);
  }, [genNodes, genEdges]);

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
        <DialogFooter className="px-6 py-4 shrink-0">
          <Button
            type="button"
            disabled={!canDownloadSketch(state)}
            onClick={() => onDownload(buildSketchDownloadRequest(value, suggestedFilename))}
            aria-label="Download sketch"
          >
            <Download aria-hidden="true" />
            Download sketch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
