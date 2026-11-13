// The app's failure surface: one module every caught or uncaught error goes
// through, so "we learn about it" has a single seam.
//
// `reportError` turns an error into a report and hands it to the configured
// sinks. A sink is the adapter: today a console sink and an Umami sink; a
// real crash reporter (Sentry or similar) is one more remote `ErrorSink`
// passed to `configureErrorReporting`, with no call site changing.
//
// The privacy guarantee is structural, not a per-adapter convention. There
// are two kinds of sink:
// - remote (`ErrorSink`) receives an `ErrorReport`: a fresh, frozen object
//   with only a fingerprint, the error's class name, where it was caught and
//   the route id. It never holds the raw error, so no adapter can forward the
//   message (which can contain flow content, node config values, emails or
//   tokens), even by accident.
// - local (`LocalErrorSink`) additionally receives the raw error. This is the
//   explicit opt-in, and it is for sinks that stay on the device (console,
//   devtools).
// The fingerprint hashes the stack frames (code locations) only, so the same
// bug groups together across users without the message.
import { track } from "./analytics";

/** Where an error was caught. Low-cardinality on purpose: it is an analytics dimension. */
export type ErrorSource =
  | "app-boundary"
  | "route-boundary"
  | "window-error"
  | "unhandled-rejection"
  | "local-persistence"
  | "action"
  | "desktop-runtime";

export type ErrorContext = {
  source: ErrorSource;
  /** A route id pattern (`/flow/$flowId`), never a concrete path with ids in it. */
  route?: string;
  /**
   * A fingerprint computed where the error happened, when the error object here
   * has no stack worth hashing — the desktop runtime hashes a Rust panic's code
   * location. Only 1–16 hex characters are accepted, so it cannot carry content;
   * anything else falls back to hashing the error.
   */
  fingerprint?: string;
};

/** The non-PII summary: everything a remote sink may see. */
export type ErrorReport = Readonly<{
  /** Stable, non-PII hash of the error's class and code locations. */
  fingerprint: string;
  /** The error's class name (`TypeError`), or `NonError:<typeof>` for thrown non-errors. */
  name: string;
  source: ErrorSource;
  route?: string;
}>;

/** The summary plus the raw error, for sinks that stay on the device. */
export type LocalErrorReport = ErrorReport & Readonly<{ error: unknown }>;

/** An adapter whose reports may leave the device. Must not assume it is the only sink. */
export type ErrorSink = (report: ErrorReport) => void;

/** An adapter that stays on the device and opts in to the raw error. */
export type LocalErrorSink = (report: LocalErrorReport) => void;

/** Logs locally with the full error; nothing leaves the device. */
export const consoleSink: LocalErrorSink = (report) => {
  console.error(`[report-error] ${report.source} ${report.name} #${report.fingerprint}`, report.error);
};

/** Sends the non-PII summary to Umami. `track` already no-ops in dev builds. */
export const umamiSink: ErrorSink = (report) => {
  const data: Record<string, string> = {
    fingerprint: report.fingerprint,
    name: report.name,
    source: report.source,
  };
  if (report.route) data.route = report.route;
  track("app_error", data);
};

/** Sinks whose reports leave the device are throttled per fingerprint, so a render loop cannot flood them. */
const REMOTE_THROTTLE_MS = 60_000;

let sinks: { local: LocalErrorSink[]; remote: ErrorSink[] } = {
  local: [consoleSink],
  remote: [umamiSink],
};
let lastRemote = new Map<string, number>();
let seen = new WeakSet<object>();
let now: () => number = () => Date.now();

/**
 * Swap the sinks (and clock, for tests). Returns a function restoring the
 * previous configuration. Wiring a crash reporter is
 * `configureErrorReporting({ remote: [umamiSink, sentrySink] })`.
 */
export function configureErrorReporting(options: {
  local?: LocalErrorSink[];
  remote?: ErrorSink[];
  clock?: () => number;
}): () => void {
  const previous = { sinks, now };
  sinks = { local: options.local ?? sinks.local, remote: options.remote ?? sinks.remote };
  now = options.clock ?? now;
  lastRemote = new Map();
  seen = new WeakSet();
  return () => {
    sinks = previous.sinks;
    now = previous.now;
    lastRemote = new Map();
    seen = new WeakSet();
  };
}

/**
 * Report an error. Never throws, and reports the same error object once even
 * when several layers see it (a caller's catch, then a boundary, then a
 * global handler). Returns the summary, or `null` when it was a duplicate.
 */
export function reportError(error: unknown, context: ErrorContext): ErrorReport | null {
  try {
    if (typeof error === "object" && error !== null) {
      if (seen.has(error)) return null;
      markSeen(error);
    }

    // Built field by field, so nothing else from `context` or `error` can ride along.
    const summary: ErrorReport = Object.freeze({
      fingerprint: suppliedFingerprint(context.fingerprint) ?? errorFingerprint(error, context.source),
      name: errorName(error),
      source: context.source,
      ...(context.route ? { route: context.route } : {}),
    });

    const local: LocalErrorReport = Object.freeze({ ...summary, error });
    for (const sink of sinks.local) safely(sink, local);

    const at = now();
    const last = lastRemote.get(summary.fingerprint);
    if (last === undefined || at - last >= REMOTE_THROTTLE_MS) {
      lastRemote.set(summary.fingerprint, at);
      for (const sink of sinks.remote) safely(sink, summary);
    }
    return summary;
  } catch {
    // Reporting must never become the failure.
    return null;
  }
}

/**
 * Mark the error and its `cause` chain as reported. A wrapper error reported
 * by a caller (`LocalPersistenceError { cause }`) then also covers the raw
 * cause when a library leaves it as an unhandled rejection.
 */
function markSeen(error: object): void {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
}

function safely<R>(sink: (report: R) => void, report: R): void {
  try {
    sink(report);
  } catch {
    // One broken adapter must not silence the others.
  }
}

/** The error's class name, restricted to identifier characters so it cannot carry content. */
export function errorName(error: unknown): string {
  // Only real errors: a thrown plain object's `name` could be a person's name.
  const isError =
    error instanceof Error || (typeof DOMException !== "undefined" && error instanceof DOMException);
  if (isError) {
    const raw = String(error.name);
    const clean = raw.replace(/[^\w.$-]/g, "").slice(0, 40);
    return clean || "Error";
  }
  return `NonError:${error === null ? "null" : typeof error}`;
}

/**
 * Hash of the error's class, the source and its top stack frames. The
 * message is excluded: V8 prefixes the stack with `Name: message`, so only
 * lines that look like frames are kept, and each frame is reduced to the
 * file name and position (origin and query string dropped, so a build served
 * from a different host still groups together).
 */
export function errorFingerprint(error: unknown, source: ErrorSource): string {
  return fnv1a([errorName(error), source, ...stackFrames(error)].join("|"));
}

/** A caller-supplied fingerprint, if it is plain hex; otherwise `undefined`. */
function suppliedFingerprint(fingerprint: string | undefined): string | undefined {
  return fingerprint !== undefined && /^[0-9a-f]{1,16}$/.test(fingerprint) ? fingerprint : undefined;
}

const MAX_FRAMES = 5;

export function stackFrames(error: unknown): string[] {
  const stack =
    typeof error === "object" && error !== null && typeof (error as { stack?: unknown }).stack === "string"
      ? (error as { stack: string }).stack
      : "";
  const frames: string[] = [];
  for (const line of stack.split("\n")) {
    const frame = parseFrame(line);
    if (frame) frames.push(frame);
    if (frames.length === MAX_FRAMES) break;
  }
  return frames;
}

// V8: "    at fn (https://host/assets/index-abc.js:1:2345)" or "    at https://host/x.js:1:2"
// JSC/Gecko: "fn@https://host/assets/index-abc.js:1:2345"
const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
const GECKO_FRAME = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/;

function parseFrame(line: string): string | null {
  const match = V8_FRAME.exec(line) ?? GECKO_FRAME.exec(line);
  if (!match) return null;
  const [, fn = "", location = "", row, col] = match;
  return `${identifier(fn)}@${fileName(location)}:${row}:${col}`;
}

/** A function name is code, but keep it to identifier characters regardless. */
function identifier(fn: string): string {
  return fn.replace(/[^\w.$<>]/g, "").slice(0, 60);
}

function fileName(location: string): string {
  const withoutQuery = location.split(/[?#]/)[0] ?? "";
  const segments = withoutQuery.split("/");
  return segments[segments.length - 1] ?? "";
}

/** 32-bit FNV-1a, hex. Not cryptographic: a grouping key, not a secret. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The subset of `window` the global handlers need, so tests can pass a plain `EventTarget`. */
type ErrorEventTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/**
 * Browser noise that is not a failure: xyflow's resize handling routinely
 * trips the ResizeObserver loop notice, and cross-origin scripts report an
 * opaque "Script error." with no error object to learn from.
 */
function isNoise(event: { message?: unknown; error?: unknown }): boolean {
  if (event.error) return false;
  const message = typeof event.message === "string" ? event.message : "";
  return message.startsWith("ResizeObserver loop") || message === "Script error." || message === "";
}

/**
 * Route `error` and `unhandledrejection` through `reportError`. Reports only:
 * the browser's own logging and default behaviour are left alone. Returns an
 * uninstall function.
 */
export function installGlobalErrorHandlers(
  target: ErrorEventTarget,
  options: { route?: () => string | undefined } = {},
): () => void {
  const route = () => {
    try {
      return options.route?.();
    } catch {
      return undefined;
    }
  };

  const onError = (event: Event) => {
    const e = event as Event & { error?: unknown; message?: unknown };
    if (isNoise(e)) return;
    reportError(e.error ?? new Error("Unknown window error"), { source: "window-error", route: route() });
  };
  const onRejection = (event: Event) => {
    const reason = (event as Event & { reason?: unknown }).reason;
    reportError(reason, { source: "unhandled-rejection", route: route() });
  };

  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
