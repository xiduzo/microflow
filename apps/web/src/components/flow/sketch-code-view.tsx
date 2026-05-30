import { useEffect, useRef, useState } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/providers/theme-provider";
import { useFlowSession, useFlowNodes, useFlowEdges, useFlowMeta } from "@/session";
import { sketchInvoker } from "@/lib/codegen";
import {
  buildSketchDownloadRequest,
  canDownloadSketch,
  createDebouncedRegenerator,
  GENERATING_SKETCH_PLACEHOLDER,
  projectSketchResult,
  serializeFlowGraph,
  type SketchDownloadHandler,
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

// Platform-dispatching invoker: Tauri IPC on desktop, the same Rust generator
// compiled to WebAssembly in the browser (see @/lib/codegen).
const invoke = sketchInvoker;

/**
 * Default download handler (Task #31): persists the sketch to a `.ino` file via
 * the native save dialog on desktop, or an in-browser download on the web. The
 * platform seams live in `sketch-download.ts`; callers may inject a handler to
 * override (e.g. tests).
 */
const defaultDownload: SketchDownloadHandler = (request) => {
  void downloadSketch(request);
};

/**
 * Read-only Monaco view of the Arduino sketch generated from the current Flow,
 * rendered as a full-height panel for the `/flow/$flowId/code` route (mirrors
 * the circuit view). Generates once on mount and re-generates — debounced —
 * whenever the Flow graph or the selected board target changes. The editor is
 * always read-only: the Author can read and copy but not edit.
 */
export function SketchCodeView({
  onDownload = defaultDownload,
}: {
  onDownload?: SketchDownloadHandler;
}) {
  const { theme } = useTheme();
  const { doc } = useFlowSession();
  const nodes = useFlowNodes(doc);
  const edges = useFlowEdges(doc);
  const meta = useFlowMeta(doc);
  // The Flow's selected board target. Threaded into every generate request so
  // the Sketch targets the chosen board; changing it re-generates (Task #29/#43).
  const { selectedTargetId } = meta;
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
    void projectSketchResult(invoke, genNodes, genEdges, selectedTargetId).then((next) => {
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
      seedSerialized: serializeFlowGraph(genNodes, genEdges, selectedTargetId),
    });
  }

  useEffect(() => {
    const regenerator = regeneratorRef.current;
    return () => regenerator?.cancel();
  }, []);

  useEffect(() => {
    regeneratorRef.current?.schedule(genNodes, genEdges, selectedTargetId);
  }, [genNodes, genEdges, selectedTargetId]);

  return (
    <div className="flex flex-col w-full h-full">
      <div className="flex-1 min-h-0 overflow-hidden rounded-2xl border bg-background">
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
      <div className="flex justify-end pt-4 shrink-0">
        <Button
          type="button"
          disabled={!canDownloadSketch(state)}
          onClick={() => onDownload(buildSketchDownloadRequest(value, suggestedFilename))}
          aria-label="Download sketch"
        >
          <Download aria-hidden="true" />
          Download sketch
        </Button>
      </div>
    </div>
  );
}
