import { afterEach, describe, expect, test } from "bun:test";
import {
  configureErrorReporting,
  errorFingerprint,
  errorName,
  installGlobalErrorHandlers,
  reportError,
  stackFrames,
  umamiSink,
  type ErrorReport,
  type LocalErrorReport,
} from "./report-error";

/** Captures what each sink kind receives; restores the real sinks after the test. */
function capture(clock?: () => number) {
  const local: LocalErrorReport[] = [];
  const remote: ErrorReport[] = [];
  restore = configureErrorReporting({
    local: [(r) => local.push(r)],
    remote: [(r) => remote.push(r)],
    clock,
  });
  return { local, remote };
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

/** An error with a fixed V8-style stack, as a production bundle would produce. */
function errorWithStack(message: string, host = "https://microflow.tech"): Error {
  const error = new TypeError(message);
  error.stack = [
    `TypeError: ${message}`,
    `    at renderNode (${host}/assets/index-abc123.js:1:2345)`,
    `    at ${host}/assets/vendor-def456.js?v=2:7:89`,
  ].join("\n");
  return error;
}

describe("errorFingerprint", () => {
  test("ignores the message, so user content cannot reach the key", () => {
    const a = errorWithStack("cannot read 'alice@example.com'");
    const b = errorWithStack("cannot read 'token=s3cr3t'");
    expect(errorFingerprint(a, "route-boundary")).toBe(errorFingerprint(b, "route-boundary"));
  });

  test("is independent of the serving origin and query string", () => {
    const web = errorWithStack("x", "https://microflow.tech");
    const desktop = errorWithStack("x", "tauri://localhost");
    expect(errorFingerprint(web, "window-error")).toBe(errorFingerprint(desktop, "window-error"));
  });

  test("separates different code locations and sources", () => {
    const a = errorWithStack("x");
    const b = new TypeError("x");
    b.stack = "TypeError: x\n    at other (https://h/assets/index-abc123.js:9:9)";
    expect(errorFingerprint(a, "window-error")).not.toBe(errorFingerprint(b, "window-error"));
    expect(errorFingerprint(a, "window-error")).not.toBe(errorFingerprint(a, "route-boundary"));
  });

  test("reads Gecko/JSC frames and drops the message line", () => {
    const error = new Error("secret");
    error.stack = "render@https://h/assets/index-abc.js:3:4\n@https://h/assets/x.js:5:6";
    expect(stackFrames(error)).toEqual(["render@index-abc.js:3:4", "@x.js:5:6"]);
    expect(stackFrames(errorWithStack("secret")).join()).not.toContain("secret");
  });
});

describe("errorName", () => {
  test("uses the class name for errors and a type tag for anything else", () => {
    expect(errorName(new RangeError("x"))).toBe("RangeError");
    expect(errorName("a string with content")).toBe("NonError:string");
    expect(errorName({ name: "Alice" })).toBe("NonError:object");
    expect(errorName(null)).toBe("NonError:null");
  });
});

describe("reportError", () => {
  test("remote sinks get only the summary: no raw error, no message, nowhere in the object", () => {
    const { local, remote } = capture();
    const secret = "alice@example.com token=s3cr3t 'My secret robot'";
    const error = errorWithStack(secret);
    // Content in a cause or in extra properties must not ride along either.
    Object.assign(error, { cause: new Error(secret), config: { password: secret } });
    reportError(error, { source: "route-boundary", route: "/flow/$flowId" });

    expect(remote).toHaveLength(1);
    const [sent] = remote;
    expect(Object.keys(sent!).sort()).toEqual(["fingerprint", "name", "route", "source"]);
    expect(sent).not.toHaveProperty("error");
    expect(Object.isFrozen(sent)).toBe(true);
    const serialized = JSON.stringify(sent);
    for (const fragment of ["alice", "s3cr3t", "secret robot", "password"]) {
      expect(serialized).not.toContain(fragment);
    }
    expect(sent).toEqual({
      fingerprint: errorFingerprint(error, "route-boundary"),
      name: "TypeError",
      source: "route-boundary",
      route: "/flow/$flowId",
    });

    // The raw error reaches only the local sinks, which opted in.
    expect(local).toHaveLength(1);
    expect(local[0]!.error).toBe(error);
  });

  test("a supplied hex fingerprint is used; anything else falls back to hashing the error", () => {
    const { remote } = capture();
    reportError(errorWithStack("a"), { source: "desktop-runtime", fingerprint: "0badf00d" });
    const content = errorWithStack("b");
    reportError(content, { source: "desktop-runtime", fingerprint: "alice@example.com" });

    expect(remote.map((r) => r.fingerprint)).toEqual([
      "0badf00d",
      errorFingerprint(content, "desktop-runtime"),
    ]);
  });

  test("the Umami adapter sends only the summary fields", () => {
    const sent: unknown[] = [];
    const globalWindow = globalThis as { window?: unknown };
    const previous = globalWindow.window;
    globalWindow.window = { umami: { track: (event: string, data: unknown) => sent.push({ event, data }) } };
    try {
      umamiSink({ fingerprint: "deadbeef", name: "TypeError", source: "window-error" });
    } finally {
      globalWindow.window = previous;
    }
    expect(sent).toEqual([
      { event: "app_error", data: { fingerprint: "deadbeef", name: "TypeError", source: "window-error" } },
    ]);
  });

  test("reports one error object once, however many layers see it", () => {
    const { local } = capture();
    const error = new Error("once");
    expect(reportError(error, { source: "action" })).not.toBeNull();
    expect(reportError(error, { source: "unhandled-rejection" })).toBeNull();
    expect(local).toHaveLength(1);
  });

  test("a reported wrapper also covers its cause, so a library's raw rejection is not reported again", () => {
    const { local } = capture();
    const cause = new Error("raw");
    reportError(new Error("wrapped", { cause }), { source: "local-persistence" });
    expect(reportError(cause, { source: "unhandled-rejection" })).toBeNull();
    expect(local).toHaveLength(1);
  });

  test("throttles remote sinks per fingerprint, but always logs locally", () => {
    let t = 0;
    const { local, remote } = capture(() => t);
    const make = () => errorWithStack("loop");
    reportError(make(), { source: "route-boundary" });
    reportError(make(), { source: "route-boundary" });
    t = 60_000;
    reportError(make(), { source: "route-boundary" });
    expect(local).toHaveLength(3);
    expect(remote).toHaveLength(2);
  });

  test("a throwing sink neither throws nor silences the others", () => {
    const remote: ErrorReport[] = [];
    restore = configureErrorReporting({
      local: [
        () => {
          throw new Error("sink down");
        },
      ],
      remote: [(r) => remote.push(r)],
    });
    expect(() => reportError(new Error("x"), { source: "action" })).not.toThrow();
    expect(remote).toHaveLength(1);
  });
});

describe("installGlobalErrorHandlers", () => {
  function fire(target: EventTarget, type: string, fields: Record<string, unknown>) {
    target.dispatchEvent(Object.assign(new Event(type), fields));
  }

  test("reports window errors and unhandled rejections with the current route", () => {
    const { local } = capture();
    const target = new EventTarget();
    const uninstall = installGlobalErrorHandlers(target, { route: () => "/templates" });

    fire(target, "error", { error: new Error("boom"), message: "boom" });
    fire(target, "unhandledrejection", { reason: "plain string" });

    expect(local.map((r) => [r.source, r.name, r.route])).toEqual([
      ["window-error", "Error", "/templates"],
      ["unhandled-rejection", "NonError:string", "/templates"],
    ]);

    uninstall();
    fire(target, "error", { error: new Error("after uninstall") });
    expect(local).toHaveLength(2);
  });

  test("ignores ResizeObserver and opaque cross-origin noise", () => {
    const { local } = capture();
    const target = new EventTarget();
    installGlobalErrorHandlers(target)();
    const uninstall = installGlobalErrorHandlers(target);

    fire(target, "error", { message: "ResizeObserver loop completed with undelivered notifications." });
    fire(target, "error", { message: "Script error." });
    expect(local).toHaveLength(0);
    uninstall();
  });

  test("a throwing route lookup does not lose the report", () => {
    const { local } = capture();
    const target = new EventTarget();
    const uninstall = installGlobalErrorHandlers(target, {
      route: () => {
        throw new Error("router not ready");
      },
    });
    fire(target, "unhandledrejection", { reason: new Error("x") });
    expect(local).toHaveLength(1);
    expect(local[0]?.route).toBeUndefined();
    uninstall();
  });
});
