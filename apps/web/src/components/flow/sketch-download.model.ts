import type { SketchDownloadRequest } from "./sketch-code-view.model";

/** Default `.ino` filename used when the Flow has no usable name. */
export const DEFAULT_SKETCH_FILENAME = "sketch.ino";

/**
 * Derive a safe `.ino` filename from a Flow name.
 *
 * The Flow name is sanitised to filesystem-friendly characters: anything that
 * is not a letter, digit, dash, underscore, or dot is collapsed to an
 * underscore, leading/trailing separators are trimmed, and a `.ino` extension
 * is ensured. When the name is missing or sanitises to nothing, the default
 * (`sketch.ino`) is used so the dialog is always pre-filled.
 */
export function deriveSketchFilename(flowName: string | null | undefined): string {
  if (flowName == null) return DEFAULT_SKETCH_FILENAME;

  const base = flowName
    .trim()
    .replace(/\.ino$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");

  if (base === "") return DEFAULT_SKETCH_FILENAME;
  return `${base}.ino`;
}

/** Outcome of a download attempt. */
export type SketchDownloadOutcome =
  | { status: "saved"; path?: string }
  | { status: "cancelled" };

/** Native save-dialog seam — returns the chosen path, or `null` when cancelled. */
export type SaveDialog = (options: {
  defaultPath: string;
  filters: { name: string; extensions: string[] }[];
}) => Promise<string | null>;

/** Write-to-disk seam (`@tauri-apps/plugin-fs` `writeTextFile`). */
export type WriteTextFile = (path: string, contents: string) => Promise<void>;

/** Browser-download seam — triggers an in-browser file download. */
export type BrowserDownload = (filename: string, contents: string) => void;

/** Injectable seams so the orchestrator is testable without Tauri or the DOM. */
export type DownloadSketchDeps = {
  isDesktop: () => boolean;
  saveDialog: SaveDialog;
  writeTextFile: WriteTextFile;
  browserDownload: BrowserDownload;
};

/**
 * Persist the sketch carried by a `SketchDownloaded` request.
 *
 * On the desktop shell: open the native save dialog (pre-filled with the
 * suggested filename, filtered to `*.ino`); on confirm, write the exact sketch
 * bytes to the chosen path; on cancel, write nothing. On the web: trigger a
 * standard browser download of the same contents and filename.
 *
 * The sketch string is written verbatim so the file matches the Code view
 * byte-for-byte.
 */
export async function downloadSketch(
  request: SketchDownloadRequest,
  deps: DownloadSketchDeps,
): Promise<SketchDownloadOutcome> {
  const filename = request.suggestedFilename;

  if (!deps.isDesktop()) {
    deps.browserDownload(filename, request.sketch);
    return { status: "saved" };
  }

  const path = await deps.saveDialog({
    defaultPath: filename,
    filters: [{ name: "Arduino sketch", extensions: ["ino"] }],
  });

  if (path == null) return { status: "cancelled" };

  await deps.writeTextFile(path, request.sketch);
  return { status: "saved", path };
}
