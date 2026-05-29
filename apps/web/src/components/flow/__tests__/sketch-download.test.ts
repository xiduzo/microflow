import { describe, expect, test } from "bun:test";
import { buildSketchDownloadRequest } from "../sketch-code-view.model";
import {
  DEFAULT_SKETCH_FILENAME,
  deriveSketchFilename,
  downloadSketch,
  type DownloadSketchDeps,
} from "../sketch-download.model";

/** Build deps with sensible spies; override per test. */
function makeDeps(overrides: Partial<DownloadSketchDeps> = {}): {
  deps: DownloadSketchDeps;
  writes: { path: string; contents: string }[];
  browserDownloads: { filename: string; contents: string }[];
} {
  const writes: { path: string; contents: string }[] = [];
  const browserDownloads: { filename: string; contents: string }[] = [];

  const deps: DownloadSketchDeps = {
    isDesktop: () => true,
    saveDialog: async (o) => o.defaultPath,
    writeTextFile: async (path, contents) => {
      writes.push({ path, contents });
    },
    browserDownload: (filename, contents) => {
      browserDownloads.push({ filename, contents });
    },
    ...overrides,
  };

  return { deps, writes, browserDownloads };
}

describe("deriveSketchFilename", () => {
  test("derives a sanitised .ino name from the Flow name", () => {
    expect(deriveSketchFilename("My Blinker Flow")).toBe("My_Blinker_Flow.ino");
  });

  test("keeps letters, digits, dashes, underscores and dots", () => {
    expect(deriveSketchFilename("led-2.0_test")).toBe("led-2.0_test.ino");
  });

  test("does not double the .ino extension", () => {
    expect(deriveSketchFilename("sketch.ino")).toBe("sketch.ino");
  });

  test("trims leading/trailing separators after sanitising", () => {
    expect(deriveSketchFilename("  *weird/name*  ")).toBe("weird_name.ino");
  });

  test("falls back to the default for a null/undefined name", () => {
    expect(deriveSketchFilename(null)).toBe(DEFAULT_SKETCH_FILENAME);
    expect(deriveSketchFilename(undefined)).toBe(DEFAULT_SKETCH_FILENAME);
  });

  test("falls back to the default when the name sanitises to nothing", () => {
    expect(deriveSketchFilename("***")).toBe(DEFAULT_SKETCH_FILENAME);
    expect(deriveSketchFilename("   ")).toBe(DEFAULT_SKETCH_FILENAME);
  });
});

describe("downloadSketch (desktop)", () => {
  // Scenario: Sketch is saved to disk on the desktop
  test("opens the save dialog and writes the chosen path", async () => {
    const { deps, writes } = makeDeps({
      saveDialog: async () => "/home/dev/blinker.ino",
    });
    const request = buildSketchDownloadRequest("void setup() {}\nvoid loop() {}", "blinker.ino");

    const outcome = await downloadSketch(request, deps);

    expect(outcome).toEqual({ status: "saved", path: "/home/dev/blinker.ino" });
    expect(writes).toEqual([
      { path: "/home/dev/blinker.ino", contents: "void setup() {}\nvoid loop() {}" },
    ]);
  });

  // Scenario: the dialog is pre-filled with the suggested filename and .ino filter
  test("pre-fills the dialog with the suggested filename and an ino filter", async () => {
    let seen: { defaultPath: string; filters: { extensions: string[] }[] } | undefined;
    const { deps } = makeDeps({
      saveDialog: async (o) => {
        seen = o;
        return o.defaultPath;
      },
    });

    await downloadSketch(buildSketchDownloadRequest("x", "my_flow.ino"), deps);

    expect(seen?.defaultPath).toBe("my_flow.ino");
    expect(seen?.filters[0]?.extensions).toEqual(["ino"]);
  });

  // Scenario: Downloaded contents match the Code view exactly
  test("writes the sketch bytes verbatim", async () => {
    const sketch = [
      "// microflow generated sketch",
      "void setup() {",
      "  pinMode(13, OUTPUT);",
      "}",
      "void loop() {}",
      "",
    ].join("\n");
    const { deps, writes } = makeDeps({ saveDialog: async () => "/tmp/s.ino" });

    await downloadSketch(buildSketchDownloadRequest(sketch, "s.ino"), deps);

    expect(writes[0]?.contents).toBe(sketch);
  });

  // Scenario: Flow with unsupported Nodes still downloads
  test("writes a sketch containing unsupported-Node placeholder comments verbatim", async () => {
    const sketch = "// Unsupported node: Mqtt\nvoid setup() {}\nvoid loop() {}";
    const { deps, writes } = makeDeps({ saveDialog: async () => "/tmp/u.ino" });

    const outcome = await downloadSketch(buildSketchDownloadRequest(sketch, "u.ino"), deps);

    expect(outcome.status).toBe("saved");
    expect(writes[0]?.contents).toBe(sketch);
  });

  // Scenario: Empty Flow downloads a valid sketch
  test("writes the empty-Flow skeleton sketch", async () => {
    const sketch = "void setup() {}\nvoid loop() {}";
    const { deps, writes } = makeDeps({ saveDialog: async () => "/tmp/e.ino" });

    const outcome = await downloadSketch(buildSketchDownloadRequest(sketch, "sketch.ino"), deps);

    expect(outcome.status).toBe("saved");
    expect(writes[0]?.contents).toBe(sketch);
  });

  // Scenario: Cancelling the save aborts the download
  test("writes nothing when the save dialog is cancelled", async () => {
    const { deps, writes } = makeDeps({ saveDialog: async () => null });

    const outcome = await downloadSketch(buildSketchDownloadRequest("x", "x.ino"), deps);

    expect(outcome).toEqual({ status: "cancelled" });
    expect(writes).toHaveLength(0);
  });
});

describe("downloadSketch (web fallback)", () => {
  test("triggers a browser download with the suggested filename and never writes to disk", async () => {
    const { deps, writes, browserDownloads } = makeDeps({
      isDesktop: () => false,
      saveDialog: async () => {
        throw new Error("save dialog must not be used on web");
      },
    });
    const sketch = "void setup() {}\nvoid loop() {}";

    const outcome = await downloadSketch(buildSketchDownloadRequest(sketch, "web_flow.ino"), deps);

    expect(outcome).toEqual({ status: "saved" });
    expect(browserDownloads).toEqual([{ filename: "web_flow.ino", contents: sketch }]);
    expect(writes).toHaveLength(0);
  });
});
