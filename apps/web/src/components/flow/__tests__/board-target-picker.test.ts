import { describe, expect, test } from "bun:test";
import type { BoardTarget } from "@/lib/bindings/BoardTarget";
import {
  DEFAULT_TARGET_ID,
  resolveSelectedTargetId,
  toTargetOptions,
} from "../board-target-picker.model";

const target = (id: string, name: string): BoardTarget => ({
  id,
  name,
  pins: [],
  timers: [],
  capabilities: [],
});

const TARGETS: BoardTarget[] = [
  target("uno", "Arduino Uno"),
  target("nano", "Arduino Nano"),
  target("esp32", "ESP32"),
];

describe("resolveSelectedTargetId", () => {
  test("returns the stored id when it is a supported target", () => {
    expect(resolveSelectedTargetId(TARGETS, "esp32")).toBe("esp32");
  });

  // Scenario: A Flow with no prior selection shows a default.
  test("falls back to the default target when nothing is stored", () => {
    expect(resolveSelectedTargetId(TARGETS, undefined)).toBe(DEFAULT_TARGET_ID);
  });

  // Edge case: a stored id no longer supported falls back rather than breaking.
  test("falls back to the default when the stored id is unsupported", () => {
    expect(resolveSelectedTargetId(TARGETS, "mega-2560")).toBe(DEFAULT_TARGET_ID);
  });

  test("falls back to the first target when the default id is absent", () => {
    const without = [target("nano", "Arduino Nano"), target("esp32", "ESP32")];
    expect(resolveSelectedTargetId(without, undefined)).toBe("nano");
  });

  test("returns undefined when no targets are supported", () => {
    expect(resolveSelectedTargetId([], undefined)).toBeUndefined();
  });
});

describe("toTargetOptions", () => {
  test("projects id and name for labelled options", () => {
    expect(toTargetOptions(TARGETS)).toEqual([
      { id: "uno", name: "Arduino Uno" },
      { id: "nano", name: "Arduino Nano" },
      { id: "esp32", name: "ESP32" },
    ]);
  });
});
