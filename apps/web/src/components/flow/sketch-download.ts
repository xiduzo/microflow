import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { isDesktop } from "@/lib/platform";
import type { SketchDownloadRequest } from "./sketch-code-view.model";
import {
  downloadSketch as runDownloadSketch,
  type DownloadSketchDeps,
  type SketchDownloadOutcome,
} from "./sketch-download.model";

/**
 * Trigger a standard in-browser download of the given text contents under the
 * suggested filename. Used as the web fallback when there is no desktop shell to
 * host a native save dialog.
 */
function browserDownload(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Real seams wiring the download orchestrator to Tauri + the browser. */
const deps: DownloadSketchDeps = {
  isDesktop,
  saveDialog: (options) => save(options),
  writeTextFile: (path, contents) => writeTextFile(path, contents),
  browserDownload,
};

/**
 * Persist a `SketchDownloaded` request: native save dialog + disk write on the
 * desktop, in-browser download on the web. The pure orchestration lives in
 * `sketch-download.model.ts`; this module only supplies the platform seams.
 */
export function downloadSketch(request: SketchDownloadRequest): Promise<SketchDownloadOutcome> {
  return runDownloadSketch(request, deps);
}
