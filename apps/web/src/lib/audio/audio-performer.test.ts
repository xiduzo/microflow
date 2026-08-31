// AudioPerformer unit tests: a fake `Audio` element, no runtime — the performer
// only drives playback, so these pin the parts that can silently misbehave
// (restart on re-trigger, volume clamp, the ended → stop report).

import { afterAll, describe, expect, it } from "bun:test";

class FakeAudio {
  static instances: FakeAudio[] = [];
  loop = false;
  volume = 1;
  currentTime = 7;
  paused = false;
  private ended: (() => void) | undefined;

  constructor(public src: string) {
    FakeAudio.instances.push(this);
  }
  addEventListener(event: string, handler: () => void) {
    if (event === "ended") this.ended = handler;
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  finish() {
    this.ended?.();
  }
}

const originalAudio = globalThis.Audio;
globalThis.Audio = FakeAudio as unknown as typeof Audio;
afterAll(() => {
  globalThis.Audio = originalAudio;
});

// Imported after the global is in place; the module only reads it at call time,
// but this keeps the ordering obvious.
const { AudioPerformer } = await import("./audio-performer");

function setup(sources: Record<string, string[]>) {
  FakeAudio.instances = [];
  const ended: string[] = [];
  const performer = new AudioPerformer(
    (nodeId, track) => sources[nodeId]?.[track],
    (nodeId) => ended.push(nodeId),
  );
  return { performer, ended };
}

describe("AudioPerformer", () => {
  it("plays the node's source with the volume clamped and loop applied", () => {
    const { performer } = setup({ "music-1": ["data:audio/mpeg;base64,AAA", "data:audio/mpeg;base64,BBB"] });
    performer.play("music-1", 0, 2, true);

    const element = FakeAudio.instances[0]!;
    expect(element.src).toBe("data:audio/mpeg;base64,AAA");
    expect(element.volume).toBe(1);
    expect(element.loop).toBe(true);
    expect(element.currentTime).toBe(0);
  });

  it("swaps the element when a different record is played", () => {
    const { performer } = setup({
      "music-1": ["data:audio/mpeg;base64,AAA", "data:audio/mpeg;base64,BBB"],
    });
    performer.play("music-1", 0, 1, false);
    performer.play("music-1", 1, 1, false);
    expect(FakeAudio.instances).toHaveLength(2);
    expect(FakeAudio.instances[0]!.paused).toBe(true);
    expect(FakeAudio.instances[1]!.src).toBe("data:audio/mpeg;base64,BBB");
  });

  it("rewinds instead of stacking a second element when re-triggered", () => {
    const { performer } = setup({ "music-1": ["data:audio/mpeg;base64,AAA", "data:audio/mpeg;base64,BBB"] });
    performer.play("music-1", 0, 0.5, false);
    FakeAudio.instances[0]!.currentTime = 3;
    performer.play("music-1", 0, 0.5, false);

    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0]!.currentTime).toBe(0);
  });

  it("reports a finished track so the node can stop itself", () => {
    const { performer, ended } = setup({ "music-1": ["data:audio/mpeg;base64,AAA", "data:audio/mpeg;base64,BBB"] });
    performer.play("music-1", 0, 1, false);
    FakeAudio.instances[0]!.finish();
    expect(ended).toEqual(["music-1"]);
  });

  it("plays nothing when the node has no file picked yet", () => {
    const { performer } = setup({});
    performer.play("music-1", 0, 1, false);
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it("stops a node that disappeared from the flow", () => {
    const { performer } = setup({ "music-1": ["data:audio/mpeg;base64,AAA", "data:audio/mpeg;base64,BBB"] });
    performer.play("music-1", 0, 1, true);
    performer.retain(new Set(["music-2"]));
    expect(FakeAudio.instances[0]!.paused).toBe(true);
  });

  it("stops and rewinds on stop, and stops everything on dispose", () => {
    const { performer } = setup({ "music-1": ["data:audio/mpeg;base64,AAA", "data:audio/mpeg;base64,BBB"] });
    performer.play("music-1", 0, 1, false);
    performer.stop("music-1");
    expect(FakeAudio.instances[0]!.paused).toBe(true);
    expect(FakeAudio.instances[0]!.currentTime).toBe(0);

    performer.play("music-1", 0, 1, false);
    performer.dispose();
    expect(FakeAudio.instances.at(-1)!.paused).toBe(true);
  });
});
