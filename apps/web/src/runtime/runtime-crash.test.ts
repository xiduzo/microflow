import { afterEach, describe, expect, test } from "bun:test";
import type { RuntimeCrash } from "@/lib/bindings/RuntimeCrash";
import { configureErrorReporting, type ErrorReport } from "@/lib/report-error";
import { surfaceRuntimeCrash, type CrashUi } from "./runtime-crash";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

function capture() {
  const remote: ErrorReport[] = [];
  restore = configureErrorReporting({ local: [], remote: [(r) => remote.push(r)] });
  return remote;
}

function ui() {
  const toasts: Array<{ title: string; options: Parameters<CrashUi["error"]>[1] }> = [];
  let reloads = 0;
  const value: CrashUi = {
    error: (title, options) => toasts.push({ title, options }),
    reload: () => {
      reloads++;
    },
  };
  return { value, toasts, reloads: () => reloads };
}

const crash = (recovered: boolean): RuntimeCrash => ({
  fingerprint: "1a2b3c4d",
  op: "dispatch",
  location: "microflow-core/src/nodes/led/runtime.rs:42",
  recovered,
  crashes: recovered ? 1 : 3,
});

describe("surfaceRuntimeCrash", () => {
  test("reports the Rust fingerprint, not one hashed from this JS stack", () => {
    const remote = capture();
    surfaceRuntimeCrash(crash(true), async () => {}, ui().value);
    expect(remote).toEqual([{ fingerprint: "1a2b3c4d", name: "RuntimeCrash", source: "desktop-runtime" }]);
  });

  test("a replayed halt is shown but not reported twice", () => {
    const remote = capture();
    const { value, toasts } = ui();
    surfaceRuntimeCrash(crash(false), async () => {}, value, { replayed: true });
    expect(remote).toEqual([]);
    expect(toasts).toHaveLength(1);
  });

  test("a recovered crash is a passing notice", () => {
    capture();
    const { value, toasts } = ui();
    surfaceRuntimeCrash(crash(true), async () => {}, value);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.options.duration).toBeUndefined();
    expect(toasts[0]!.options.action).toBeUndefined();
  });

  test("a halt stays up and its action restarts the runtime, then reloads", async () => {
    capture();
    const { value, toasts, reloads } = ui();
    let restarted = 0;
    surfaceRuntimeCrash(
      crash(false),
      async () => {
        restarted++;
      },
      value,
    );

    const [toast] = toasts;
    expect(toast!.options.duration).toBe(Number.POSITIVE_INFINITY);
    toast!.options.action!.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restarted).toBe(1);
    expect(reloads()).toBe(1);
  });
});
