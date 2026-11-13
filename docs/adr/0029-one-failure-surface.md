# ADR-0029 — One failure surface: `reportError`, pluggable sinks, no PII

- **Status:** accepted (2026-11-13)
- **Date:** 2026-11-13
- **Deciders:** sander

> **Decision:** every error the web app catches, and every one it does not,
> goes through one module, `reportError` (`apps/web/src/lib/report-error.ts`).
> It turns the error into an **Error report** that carries no personal or flow
> data and hands it to pluggable **Error sinks**. The screens a user sees when
> something throws never touch the flow document. A release runs the same
> checks a pull request does, plus the browser smoke suite, on the exact commit
> it ships.

## Context

Errors had no single path. A thrown render error showed the router's default
screen; an unhandled rejection reached only the console; a failed save of a
local flow did nothing at all; and nothing reached us. Two failures were silent
for the user too: `y-indexeddb` never catches its open promise, so a browser
that refused IndexedDB left `whenSynced` pending forever and local edits
unsaved with no sign of it; and a release built `main` as it was when the job
ran, not the tagged commit the checks had passed.

Error text is not safe to send anywhere. A message can quote a node's config, a
flow name, an e-mail address or a token, and a stack can carry the same through
a thrown value. Any sink that receives the raw error can leak it, whatever its
author intended.

## Decision

**D1 — One module, two kinds of sink.** `reportError(error, { source, route })`
is the only reporting call site. A remote `ErrorSink` receives a frozen
`ErrorReport`, built field by field: a fingerprint (a hash of the error's class
and its stack's code locations), the class name, the `source` where it was
caught, and the route id *pattern* (`/flow/$flowId`, never the concrete path).
It never holds the raw error, so no adapter can forward the message even by
accident. A `LocalErrorSink` (the console) also gets the raw error and stays on
the device. Today the remote sink is Umami's `app_error` event; a crash reporter
is one more remote sink passed to `configureErrorReporting`, with no call site
changing. Remote reports are throttled per fingerprint (60 s), and an error
object is reported once however many layers catch it.

**D2 — Everything is caught somewhere, and reported where it is caught.**
`AppErrorBoundary` wraps the router; each route has an error screen and the root
a full-screen variant; there is a not-found screen; `installGlobalErrorHandlers`
covers `error` and `unhandledrejection`. Failed user actions (a local save, a
template) show a toast and report. The desktop runtime reports a crash with a
fingerprint computed in Rust from the panic's code location, never its message.
A local store that will not open rejects `whenSynced` with a
`LocalPersistenceError` and shows in the session status, instead of hanging.

**D3 — Error screens never write to the document.** They show the error's
reference (the same fingerprint the report carries) and offer Try again, Reload
and Back to flows. A reload is safe because the local adapter persists every
update as it happens and a cloud flow lives on the server; a screen that tried
to save would be writing from a state that just failed.

**D4 — A release runs the pull-request checks first, on the tagged commit.**
`release.yml` calls `rust.yml`, `typescript.yml` and `smoke.yml` as reusable
workflows, and `create-release` needs all three plus `main-is-tag`, which fails
when `main` has moved past the tag (the later jobs build from `main`). A commit
that did not pass the checks cannot ship.

## Consequences

- One place answers "do we hear about this?", and privacy is a property of the
  types rather than of each adapter's care.
- A fingerprint includes code locations, so it groups one bug across users but
  only within one build.
- Releasing a commit that is not `main`'s head means moving `main` or re-tagging;
  the gate refuses otherwise.
- The smoke suite adds minutes to a release and needs Obscura on CI.

## References

- `apps/web/src/lib/report-error.ts` — the module, sinks and global handlers.
- `apps/web/src/shell/failure-screens.tsx`, `apps/web/src/main.tsx`, `apps/web/src/routes/__root.tsx` — the screens and boundaries.
- `apps/web/src/session/indexeddb-sync-adapter.ts` — `LocalPersistenceError`.
- `apps/web/src/runtime/runtime-crash.ts` — the desktop crash report.
- `.github/workflows/release.yml`, `smoke.yml`; `apps/web/e2e/` — the release gate and the smoke suite.
- `CONTEXT.md` § Failure surface, Error report, Error sink, Browser smoke suite.
