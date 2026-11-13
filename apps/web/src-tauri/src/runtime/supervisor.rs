//! Supervision for the desktop runtime actor: what happens when a turn panics.
//!
//! The browser host treats a trapped wasm module as terminal (ADR-0017 D3): the
//! user reloads. The desktop actor owns the board's serial port and is an
//! app-lifetime thread, so a panic there used to kill the flow *and* strand the
//! port with no surface saying so. The desktop answer is **respawn**: the actor
//! catches the panic at the turn boundary, throws the runtime away (a panic
//! aborts mid-mutation, so its invariants are gone — the same judgement as
//! ADR-0017 D3), puts the board in a safe state, and builds a fresh runtime from
//! the facts it still holds: the live board session's pin table and the last
//! flow.
//!
//! This module holds the host-free half of that policy, so it is testable
//! without a thread, a board or a Tauri app:
//!
//! - [`CrashGuard`] — the crash-loop guard: respawn until [`CRASH_LIMIT`] panics
//!   land inside [`CRASH_WINDOW`], then halt.
//! - [`Fault`] — one caught panic, reduced to a non-PII fingerprint (the turn's
//!   op and the panic's code location; never the message, which can carry flow
//!   content).
//! - [`RuntimeCrash`] — the `runtime-crashed` event payload the webview reports.
//!
//! The actor half (catching, rebuilding, re-applying) lives on `host::Actor`.

use serde::Serialize;
use std::any::Any;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::sync::Once;
use std::time::{Duration, Instant};
use ts_rs::TS;

/// Panics that may land inside [`CRASH_WINDOW`] before the actor stops
/// respawning. The third one inside the window halts.
pub const CRASH_LIMIT: usize = 3;
/// The crash-loop window.
pub const CRASH_WINDOW: Duration = Duration::from_secs(60);

/// What the actor does after a panic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Build a fresh runtime and carry on.
    Respawn,
    /// A crash loop: stop driving the board until the user restarts.
    Halt,
}

/// The crash-loop guard: a sliding window of recent panic times.
#[derive(Debug)]
pub struct CrashGuard {
    limit: usize,
    window: Duration,
    crashes: VecDeque<Instant>,
}

impl Default for CrashGuard {
    fn default() -> Self {
        Self::new(CRASH_LIMIT, CRASH_WINDOW)
    }
}

impl CrashGuard {
    #[must_use]
    pub fn new(limit: usize, window: Duration) -> Self {
        Self { limit, window, crashes: VecDeque::with_capacity(limit) }
    }

    /// Record a panic at `now` and decide. Panics older than the window are
    /// forgotten first, so a crash an hour ago does not count against one now.
    pub fn record(&mut self, now: Instant) -> Verdict {
        while self.crashes.front().is_some_and(|&at| now.duration_since(at) >= self.window) {
            self.crashes.pop_front();
        }
        self.crashes.push_back(now);
        if self.crashes.len() >= self.limit { Verdict::Halt } else { Verdict::Respawn }
    }

    /// Panics counted inside the current window.
    #[must_use]
    pub fn recent(&self) -> usize {
        self.crashes.len()
    }

    /// Forget every recorded panic (the user asked for a restart).
    pub fn reset(&mut self) {
        self.crashes.clear();
    }
}

/// The `runtime-crashed` event: one caught panic, as the webview may see it.
///
/// Non-PII by construction: the turn's op name, the panic's code location and
/// a hash of the two. The panic *message* stays in the local log — it can quote
/// a node id, a topic or a value from the flow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RuntimeCrash {
    /// 8 hex chars: FNV-1a of `op|location`. Groups the same bug across users.
    pub fingerprint: String,
    /// The actor turn that panicked (`dispatch`, `feedBytes`, `respawn`, …).
    pub op: String,
    /// Crate-relative code location of the panic (`microflow-core/src/…:42`),
    /// or `unknown` when the panic hook did not see it.
    pub location: String,
    /// `true`: a fresh runtime is running the flow again. `false`: the crash
    /// guard tripped and the runtime is halted until `runtime_restart`.
    pub recovered: bool,
    /// Panics inside the current crash-loop window, this one included.
    #[ts(type = "number")]
    pub crashes: usize,
}

/// One caught panic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fault {
    pub op: &'static str,
    pub location: String,
    pub fingerprint: String,
}

impl Fault {
    /// Reduce a caught panic in turn `op` to its fingerprint. Reads (and clears)
    /// the location the panic hook recorded on this thread.
    #[must_use]
    pub fn capture(op: &'static str) -> Self {
        let location = LAST_PANIC.with(RefCell::take).unwrap_or_else(|| "unknown".to_string());
        let fingerprint = fnv1a(&format!("{op}|{location}"));
        Self { op, location, fingerprint }
    }

    #[must_use]
    pub fn event(&self, recovered: bool, crashes: usize) -> RuntimeCrash {
        RuntimeCrash {
            fingerprint: self.fingerprint.clone(),
            op: self.op.to_string(),
            location: self.location.clone(),
            recovered,
            crashes,
        }
    }
}

/// The panic payload's message, for the local log only.
#[must_use]
pub fn panic_message(payload: &(dyn Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("<non-string panic payload>")
}

thread_local! {
    /// The code location of this thread's most recent panic, set by the hook.
    static LAST_PANIC: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Install (once per process) a panic hook that records each panic's code
/// location in a thread-local before chaining to the previous hook, so the
/// default stderr report and any hook installed earlier still run. A caught
/// panic's payload carries only the message; the location is what makes a
/// fingerprint stable without quoting flow content.
pub fn install_panic_hook() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if let Some(location) = info.location() {
                let at = format!("{}:{}", crate_relative(location.file()), location.line());
                LAST_PANIC.with(|slot| *slot.borrow_mut() = Some(at));
            }
            previous(info);
        }));
    });
}

/// A source path cut down to `<crate>/src/<path>`. A dependency's path is
/// absolute (`/Users/<name>/.cargo/registry/…`), so everything before the
/// crate directory is dropped — it can name the user.
#[must_use]
pub fn crate_relative(file: &str) -> String {
    let parts: Vec<&str> = file.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
    match parts.iter().rposition(|p| *p == "src") {
        Some(src) => parts[src.saturating_sub(1)..].join("/"),
        None => parts.last().copied().unwrap_or_default().to_string(),
    }
}

/// 32-bit FNV-1a, hex — the same grouping hash the webview's `reportError`
/// uses. A grouping key, not a secret.
#[must_use]
pub fn fnv1a(input: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in input.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_halts_on_the_third_panic_inside_the_window() {
        let mut guard = CrashGuard::default();
        let t0 = Instant::now();
        assert_eq!(guard.record(t0), Verdict::Respawn);
        assert_eq!(guard.record(t0 + Duration::from_secs(10)), Verdict::Respawn);
        assert_eq!(guard.record(t0 + Duration::from_secs(59)), Verdict::Halt);
    }

    #[test]
    fn guard_forgets_panics_older_than_the_window() {
        let mut guard = CrashGuard::default();
        let t0 = Instant::now();
        guard.record(t0);
        guard.record(t0 + Duration::from_secs(1));
        // The first two have aged out: this is the only one in the window.
        assert_eq!(guard.record(t0 + Duration::from_secs(70)), Verdict::Respawn);
        assert_eq!(guard.recent(), 1);
    }

    #[test]
    fn guard_reset_starts_a_fresh_window() {
        let mut guard = CrashGuard::default();
        let t0 = Instant::now();
        guard.record(t0);
        guard.record(t0);
        guard.reset();
        assert_eq!(guard.record(t0), Verdict::Respawn);
    }

    #[test]
    fn location_drops_everything_before_the_crate() {
        assert_eq!(
            crate_relative("/Users/someone/.cargo/registry/src/index.crates.io-1/serde_json-1.0.1/src/de.rs"),
            "serde_json-1.0.1/src/de.rs"
        );
        assert_eq!(
            crate_relative("crates/microflow-core/src/nodes/led/runtime.rs"),
            "microflow-core/src/nodes/led/runtime.rs"
        );
        assert_eq!(crate_relative(r"C:\Users\someone\x\src\lib.rs"), "x/src/lib.rs");
        assert_eq!(crate_relative("main.rs"), "main.rs");
    }

    #[test]
    fn fingerprint_matches_the_webview_hash() {
        // `fnv1a("")` in `report-error.ts` is the FNV offset basis.
        assert_eq!(fnv1a(""), "811c9dc5");
        assert_eq!(fnv1a("a"), "e40c292c");
    }

    #[test]
    fn a_caught_panic_is_fingerprinted_by_op_and_location_not_message() {
        install_panic_hook();
        let caught = |secret: &'static str| {
            let result = std::panic::catch_unwind(|| panic!("flow says {secret}"));
            assert!(result.is_err());
            Fault::capture("dispatch")
        };
        let a = caught("alice@example.com");
        let b = caught("bob@example.com");
        assert_ne!(a.location, "unknown", "the hook recorded the location");
        assert!(a.location.starts_with("src-tauri/src/runtime/supervisor.rs:"), "{}", a.location);
        assert_eq!(a.fingerprint.len(), 8);
        // Same op, same line: same fingerprint, whatever the message said.
        assert_eq!(a.fingerprint, b.fingerprint);
        let event = a.event(true, 1);
        let json = serde_json::to_string(&event).unwrap();
        assert!(!json.contains("example.com"), "{json}");
    }
}
