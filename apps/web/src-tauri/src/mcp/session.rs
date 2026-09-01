//! What an MCP client is allowed to do right now, and the hop that does it.
//!
//! The tools this server exposes are *not* Rust: they mutate the Yjs
//! `FlowDocument` that lives in the webview (`lib/ai/flow-tools.ts`), which is
//! also what makes an AI edit sync, undo and reach a board like a human one. So
//! the server owns no roster of its own — it owns a **session**, which the
//! webview opens for the length of one Ask AI turn and closes after, and every
//! `tools/call` is a round trip up into the page.
//!
//! That inversion is the whole design, and every guard below follows from it:
//!
//! - **No session, no tools.** An idle Microflow exposes an empty `tools/list`
//!   and refuses every call. The socket is always listening; the surface behind
//!   it exists only while a turn is running.
//! - **A token, not a path.** The socket is `0600`, so the OS already keeps
//!   other users out. The token keeps *this* user's other processes out: the
//!   relay presents it before anything else, and a connection that never
//!   presents the live session's token sees the same nothing an idle app shows.
//! - **A budget.** The agent loop is inside the CLI now, so `MAX_ITERATIONS` in
//!   `turn-runner.ts` no longer bounds it. The session carries a call budget
//!   instead; spending it does not kill the run, it starts answering every
//!   further call with "you are out of calls, summarise what you did", which a
//!   model can act on and a hard kill cannot.
//! - **A deadline.** The webview can be busy, reloading, or gone. Every hop is
//!   bounded by [`CALL_TIMEOUT`] and answers with a tool error rather than
//!   leaving the CLI — and the user — waiting on a reply that is never coming.
//! - **A clean end.** Closing the session fails every in-flight call at once,
//!   so aborting an Ask AI turn does not leave a CLI blocked on a tool that has
//!   nowhere left to run.
//!
//! The roster is captured *by value* when the session opens rather than fetched
//! per `tools/list`. `read-only` and `confirm` modes expose different tool sets
//! (see `createFlowTools`), so the roster is part of the session's identity —
//! and a listing then costs no hop at all, which means a wedged webview cannot
//! stop a client from connecting and being told what is available.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, RwLock};

/// How long one tool call may wait on the webview before it is reported as
/// failed. Generous: the hop itself is sub-millisecond, but the page applies
/// the change inside a Yjs transaction that may be syncing to collaborators.
/// Short enough that a reloaded webview surfaces as an error in the CLI's
/// transcript rather than as a hang the user has to notice.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// A tool as the webview described it, passed straight through to `tools/list`.
///
/// `input_schema` is JSON Schema the page produced from the tool's own zod
/// schema (`z.toJSONSchema`), so the schema a CLI is given and the schema the
/// tool validates against cannot drift — they are the same object.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

impl ToolSpec {
    fn as_mcp(&self) -> Value {
        json!({
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
        })
    }
}

/// One Ask AI turn's worth of exposure.
#[derive(Debug)]
struct Session {
    /// Presented by the relay on connect. Never logged.
    token: String,
    tools: Vec<ToolSpec>,
    /// Calls left. Signed so the "spent" state survives a race between two
    /// concurrent calls without wrapping.
    budget: AtomicI64,
}

/// How a CLI reaches this server: the relay, as a command to spawn.
///
/// Built here rather than in the webview because the path is
/// [`std::env::current_exe`] — a `.app` bundle in production, `target/debug`
/// under `tauri dev`, and neither is something the page can work out.
#[derive(Debug, Clone, Serialize)]
pub struct RelayCommand {
    pub bin: String,
    pub args: Vec<String>,
}

/// The MCP server's managed state.
#[derive(Debug, Default)]
pub struct McpState {
    session: RwLock<Option<Arc<Session>>>,
    /// Calls sent up to the webview and not yet answered.
    pending: DashMap<u64, oneshot::Sender<Result<Value, String>>>,
    next_id: AtomicU64,
    /// Whether a transport actually bound. A platform without one, or a socket
    /// that failed to bind, must not hand the webview a relay command it would
    /// spawn into a refused connection — Ask AI falls back to prose instead.
    listening: AtomicBool,
}

/// Why a call was refused before it ever reached the webview. Rendered to the
/// model as a tool error, so each one says what to do instead.
fn refusal(text: &str) -> String {
    text.to_string()
}

impl McpState {
    /// Record that a transport bound. Called once, from `listen`.
    pub fn set_listening(&self) {
        self.listening.store(true, Ordering::SeqCst);
    }

    /// Open a session. Replaces any previous one — a second Ask AI turn is the
    /// normal way this happens, and the old turn's clients should stop being
    /// able to write the moment it ends.
    pub async fn open(&self, token: String, tools: Vec<ToolSpec>, budget: i64) {
        let previous = self
            .session
            .write()
            .await
            .replace(Arc::new(Session { token, tools, budget: AtomicI64::new(budget) }));
        if previous.is_some() {
            self.fail_pending("this Ask AI turn was replaced by a new one");
        }
    }

    /// Close the session `token` opened, if it is still the live one.
    ///
    /// Token-checked so a stale close (an aborted turn's cleanup arriving after
    /// the next turn opened) cannot tear down the session that replaced it.
    pub async fn close(&self, token: &str) {
        let mut guard = self.session.write().await;
        if guard.as_ref().is_some_and(|s| s.token == token) {
            *guard = None;
            drop(guard);
            self.fail_pending("the Ask AI turn ended");
        }
    }

    /// Answer every in-flight call at once. The receivers are dropped either
    /// way; sending the reason is what turns a silent timeout into a sentence.
    fn fail_pending(&self, reason: &str) {
        let ids: Vec<u64> = self.pending.iter().map(|entry| *entry.key()).collect();
        for id in ids {
            if let Some((_, reply)) = self.pending.remove(&id) {
                let _ = reply.send(Err(refusal(reason)));
            }
        }
    }

    /// The live session, if `token` names it.
    async fn authorized(&self, token: Option<&str>) -> Option<Arc<Session>> {
        let session = self.session.read().await.clone()?;
        match token {
            Some(token) if token == session.token => Some(session),
            _ => None,
        }
    }

    /// What `tools/list` answers. Empty when there is no session or the client
    /// never presented its token — the same answer, deliberately: a client that
    /// is not part of a turn learns nothing about what a turn would expose.
    pub async fn tools(&self, token: Option<&str>) -> Vec<Value> {
        match self.authorized(token).await {
            Some(session) => session.tools.iter().map(ToolSpec::as_mcp).collect(),
            None => Vec::new(),
        }
    }

    /// Route the webview's answer back to the call that is waiting for it.
    ///
    /// An id with nobody waiting is not an error: the call may have timed out
    /// or the session may have closed under it, and the late reply is simply
    /// dropped.
    pub fn resolve(&self, id: u64, result: Result<Value, String>) {
        if let Some((_, reply)) = self.pending.remove(&id) {
            let _ = reply.send(result);
        }
    }

    /// Run one tool in the webview and wait for its result.
    ///
    /// Errors are values, not failures: every arm returns a string the model
    /// reads as a tool error and can act on.
    pub async fn call(
        &self,
        app: &AppHandle,
        token: Option<&str>,
        name: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        let Some(session) = self.authorized(token).await else {
            return Err(refusal(
                "Microflow has no Ask AI turn open, so its flow tools are not available right now.",
            ));
        };
        if !session.tools.iter().any(|tool| tool.name == name) {
            let names: Vec<&str> = session.tools.iter().map(|t| t.name.as_str()).collect();
            return Err(format!(
                "no tool '{name}' — this turn exposes: {}",
                names.join(", ")
            ));
        }
        if session.budget.fetch_sub(1, Ordering::SeqCst) <= 0 {
            return Err(refusal(
                "you have used every tool call allowed for this turn — stop calling tools and \
                 summarise what you changed.",
            ));
        }

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply, wait) = oneshot::channel();
        self.pending.insert(id, reply);

        // The webview is the only listener. A failed emit means no window is
        // there to hear it, which is worth saying plainly rather than letting
        // the call sit until the deadline.
        if app
            .emit("mcp-request", json!({ "id": id, "name": name, "arguments": arguments }))
            .is_err()
        {
            self.pending.remove(&id);
            return Err(refusal("the Microflow window is not available."));
        }

        match tokio::time::timeout(CALL_TIMEOUT, wait).await {
            Ok(Ok(result)) => result,
            // The sender was dropped without a value: the session closed while
            // the call was out, and `fail_pending` lost the race to say so.
            Ok(Err(_)) => Err(refusal("the Ask AI turn ended before this call finished.")),
            Err(_) => {
                self.pending.remove(&id);
                Err(format!(
                    "Microflow did not answer within {}s — it may be busy or reloading.",
                    CALL_TIMEOUT.as_secs()
                ))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The webview's half
// ---------------------------------------------------------------------------

/// Open the MCP session for one Ask AI turn, and answer with the command a CLI
/// should spawn to reach it — or `null` when nothing is listening, which is the
/// signal for Ask AI to fall back to a plain prose turn instead of spawning a
/// CLI that would find no tools.
#[tauri::command]
pub async fn mcp_session_start(
    token: String,
    tools: Vec<ToolSpec>,
    budget: i64,
    state: tauri::State<'_, McpState>,
) -> Result<Option<RelayCommand>, String> {
    if !state.listening.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let bin = std::env::current_exe()
        .map_err(|error| format!("could not locate the Microflow binary: {error}"))?
        .to_string_lossy()
        .into_owned();
    log::info!("[mcp] session open — {} tools, budget {budget}", tools.len());
    state.open(token.clone(), tools, budget).await;
    Ok(Some(RelayCommand { bin, args: vec!["--mcp".into(), token] }))
}

/// Close the session, failing anything still in flight.
#[tauri::command]
pub async fn mcp_session_end(
    token: String,
    state: tauri::State<'_, McpState>,
) -> Result<(), String> {
    state.close(&token).await;
    Ok(())
}

/// The result of one `mcp-request`, from the webview that ran it.
///
/// `error` is a *tool* error — the model reads it and corrects itself. There is
/// no transport failure shape here on purpose: the flow tools already return
/// their rejections as values (`flow-tools.ts`), and anything that throws in the
/// page arrives as `error` too.
#[tauri::command]
pub fn mcp_tool_result(
    id: u64,
    result: Option<Value>,
    error: Option<String>,
    state: tauri::State<'_, McpState>,
) {
    state.resolve(id, error.map_or_else(|| Ok(result.unwrap_or(Value::Null)), Err));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str) -> ToolSpec {
        ToolSpec {
            name: name.into(),
            description: "t".into(),
            input_schema: json!({ "type": "object" }),
        }
    }

    #[tokio::test]
    async fn idle_app_exposes_nothing() {
        let state = McpState::default();
        assert!(state.tools(Some("t")).await.is_empty());
        assert!(state.tools(None).await.is_empty());
    }

    #[tokio::test]
    async fn a_wrong_token_sees_what_no_token_sees() {
        let state = McpState::default();
        state.open("secret".into(), vec![spec("get_flow")], 10).await;
        assert_eq!(state.tools(Some("secret")).await.len(), 1);
        // The guard that keeps this user's *other* processes out.
        assert!(state.tools(Some("guess")).await.is_empty());
        assert!(state.tools(None).await.is_empty());
    }

    #[tokio::test]
    async fn closing_needs_the_token_that_opened() {
        let state = McpState::default();
        state.open("first".into(), vec![spec("get_flow")], 10).await;
        state.open("second".into(), vec![spec("get_flow")], 10).await;
        // An aborted turn's cleanup arriving late must not disarm the turn that
        // replaced it.
        state.close("first").await;
        assert_eq!(state.tools(Some("second")).await.len(), 1);
        state.close("second").await;
        assert!(state.tools(Some("second")).await.is_empty());
    }

    #[tokio::test]
    async fn a_late_result_is_dropped_not_panicked_on() {
        let state = McpState::default();
        state.resolve(41, Ok(json!("nobody is waiting")));
    }
}
