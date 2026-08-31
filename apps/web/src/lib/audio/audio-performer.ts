// The audio performer: host speaker playback for the `Music` node — shared by
// BOTH hosts. The browser reactor owns one directly; the desktop actor forwards
// its `AudioPlay`/`AudioStop` cloud requests into the webview (`audio-request`),
// which drives this same class. The desktop app is a browser, so linking a Rust
// audio backend would be a second implementation of what `HTMLAudioElement`
// already does.
//
// Like the MidiPerformer it is host-free: it never touches the runtime. It gets
// the track's `src` from an injected resolver (the flow already holds the data
// URL — see `AudioSrcResolver`) and reports track end through an injected
// callback, which both hosts wire to a `stop` dispatch on the node. That is the
// same port a wire can drive, so `value` falls to false down one path only.

/** Resolve one record of a `Music` node — `data.tracks[track].src`, a data URL.
 *  The runtime names the record by index; the file itself never reaches it. */
export type AudioSrcResolver = (nodeId: string, track: number) => string | undefined;
/** Called when a non-looping track finishes on its own. */
export type AudioEnded = (nodeId: string) => void;

/**
 * The record sources on a `Music` node's `data`, in record order — the shape
 * both hosts resolve `AudioPlay`'s index against. Lives here so the two of them
 * cannot disagree about where the files sit on the node.
 */
export function audioSourcesOf(data: Record<string, unknown>): string[] {
  const tracks = data.tracks;
  if (!Array.isArray(tracks)) return [];
  return tracks.map((track: unknown) => {
    const src = (track as { src?: unknown } | null)?.src;
    return typeof src === "string" ? src : "";
  });
}

export class AudioPerformer {
  /** One element per node, kept across plays so a re-trigger reuses it. */
  private readonly elements = new Map<string, HTMLAudioElement>();
  private disposed = false;

  constructor(
    private readonly resolveSrc: AudioSrcResolver,
    private readonly onEnded: AudioEnded,
  ) {}

  /** Start (or restart) one of `nodeId`'s records. Re-triggering while it plays
   *  rewinds to the start, matching the Piezo node's `trigger`; switching to a
   *  different record replaces the one playing (a node has one voice). */
  play(nodeId: string, track: number, volume: number, loop: boolean): void {
    if (this.disposed) return;
    const src = this.resolveSrc(nodeId, track);
    if (src === undefined || src === "") {
      console.warn(`[audio-performer] ${nodeId} has no audio file for record ${track}`);
      return;
    }

    let element = this.elements.get(nodeId);
    if (element === undefined || element.src !== src) {
      element?.pause();
      element = new Audio(src);
      element.addEventListener("ended", () => {
        // Loops never fire `ended`; a natural end is reported so the node's
        // value falls back to false.
        this.onEnded(nodeId);
      });
      this.elements.set(nodeId, element);
    }

    element.loop = loop;
    element.volume = Math.min(Math.max(volume, 0), 1);
    element.currentTime = 0;
    // Autoplay policies reject playback until the page has been interacted
    // with; running a flow is an interaction, so this is a real error path.
    element.play().catch((error: unknown) => {
      console.warn(`[audio-performer] ${nodeId} could not play:`, error);
    });
  }

  stop(nodeId: string): void {
    const element = this.elements.get(nodeId);
    if (element === undefined) return;
    element.pause();
    element.currentTime = 0;
  }

  /** Stop and forget every node not in `nodeIds` — a `Music` node deleted (or
   *  edited into a different file) mid-playback would otherwise keep playing
   *  with nothing left on the canvas to stop it. */
  retain(nodeIds: { has(nodeId: string): boolean }): void {
    for (const [nodeId, element] of this.elements) {
      if (nodeIds.has(nodeId)) continue;
      element.pause();
      this.elements.delete(nodeId);
    }
  }

  /** Stop every track (flow torn down, page left). */
  dispose(): void {
    this.disposed = true;
    for (const element of this.elements.values()) {
      element.pause();
      element.src = "";
    }
    this.elements.clear();
  }
}
