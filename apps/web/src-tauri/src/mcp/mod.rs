//! The MCP server: Microflow's flow tools, as tools an agent CLI can call.
//!
//! Ask AI drives the flow through a small tool set — `get_flow`, `add_node`,
//! `connect`, … — and until now only an HTTP provider could call them, because
//! `chat()` needs a wire format for tool calls and a CLI has none. A CLI does
//! have MCP. So instead of teaching `cli-adapter.ts` to fake tool calls out of
//! prose, the tools are published where the CLI can already reach them, and the
//! CLI runs its own agent loop against them.
//!
//! ```text
//! Ask AI  ─spawn─▶  claude -p --mcp-config …
//!  (webview)              │ stdio
//!                         ▼
//!                   microflow --mcp        ← [`relay`], the same binary
//!                         │ unix socket / named pipe
//!                         ▼
//!                   this server            ← [`serve`]
//!                         │ "mcp-request" event  +  `mcp_tool_result` command
//!                         ▼
//!                   the flow tools         ← back in the webview, on the Yjs doc
//! ```
//!
//! # Why the loop goes out and back into the same process
//!
//! The tools mutate the collaborative `FlowDocument`, which lives in the
//! webview: that is what makes an AI edit sync to collaborators, land on the
//! undo stack and reach a connected board without any of it being written
//! twice. Re-implementing them in Rust to save a hop would mean a second
//! definition of every tool and a parity guard to keep them honest. The hop is
//! cheaper. [`session`] owns it, and every bound on it.
//!
//! # Why a socket and not a port
//!
//! MCP's stdio transport means the *client* spawns its server as a child
//! process, so the server has to be reachable from a fresh process that shares
//! nothing with us. A unix socket at `0600` (a named pipe on Windows) makes the
//! OS the access control: no port to collide, no token in a URL, no CORS, and
//! nothing listening on a network interface. [`relay`] is the same binary in a
//! mode that returns before Tauri boots, so `single_instance` never sees it.
//!
//! The socket is not the authorisation, though — every process this user runs
//! can open it. The session token is (see [`session`]).
//!
//! # Errors
//!
//! A refused or failed tool is a **tool result** with `isError: true`, never a
//! JSON-RPC error: the call reached us and the model is meant to read why it
//! did not work and try something else. JSON-RPC errors are for frames that
//! could not be routed at all — bad JSON, no method, a `tools/call` with no
//! name.

pub mod session;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub use session::{
    mcp_session_end, mcp_session_start, mcp_tool_result, McpState, RelayCommand, ToolSpec,
};

/// The MCP revision this server implements.
const PROTOCOL_VERSION: &str = "2025-06-18";

/// The server name a client sees. Also the `mcp__<name>__<tool>` prefix the
/// CLI's own permission flags are written against, so it is part of the wire
/// contract with `cli-providers.ts` and not a label.
pub const SERVER_NAME: &str = "microflow";

/// How the relay presents the session token: a notification, before anything
/// else, on a connection that is otherwise a plain MCP stream.
///
/// A non-standard method rather than a field on `initialize` because the
/// *client* owns `initialize` and we do not get to add to it. A client that
/// never sends this is not broken — it is simply unauthorised, and sees an
/// empty tool list.
const ATTACH_METHOD: &str = "microflow/attach";

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// A tool's answer. MCP content blocks are text; the reader is a model.
fn ok_result(value: &Value) -> Value {
    json!({ "content": [{ "type": "text", "text": value.to_string() }], "isError": false })
}

fn error_result(message: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

fn response(id: &Value, result: &Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn failure(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

// ---------------------------------------------------------------------------
// The protocol
// ---------------------------------------------------------------------------

/// One connection's mutable state. Only the token so far, but it is what makes
/// a connection a *session member* rather than an anonymous caller.
#[derive(Default)]
pub struct Peer {
    token: Option<String>,
}

/// What the protocol needs of the world: a roster and a way to run one tool.
///
/// Two implementations, and both earn their place. [`Live`] is the real one —
/// the session plus the hop into the webview. The other is in this module's
/// tests, and it is the only way the wire below is testable at all: `tools/call`
/// needs an `AppHandle`, and nothing in this crate can build one. Framing,
/// attach, and "an unauthorised client sees an empty list" are exactly the
/// things a smoke test finds last and a unit test finds instantly.
#[async_trait::async_trait]
pub trait Tools: Send + Sync {
    async fn list(&self, token: Option<&str>) -> Vec<Value>;
    async fn call(&self, token: Option<&str>, name: &str, arguments: Value)
        -> Result<Value, String>;
}

/// The running app: this turn's session, and the webview that owns the tools.
struct Live<'a> {
    app: &'a AppHandle,
    state: &'a McpState,
}

#[async_trait::async_trait]
impl Tools for Live<'_> {
    async fn list(&self, token: Option<&str>) -> Vec<Value> {
        self.state.tools(token).await
    }

    async fn call(
        &self,
        token: Option<&str>,
        name: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        self.state.call(self.app, token, name, arguments).await
    }
}

/// Answer one JSON-RPC frame. [`None`] for a notification, which by definition
/// carries no `id` and gets no reply.
pub async fn handle(tools: &dyn Tools, peer: &mut Peer, request: &Value) -> Option<Value> {
    let method = request.get("method").and_then(Value::as_str).unwrap_or_default();
    let params = request.get("params");

    // Notifications first: they have no id, and `initialized` is one every
    // client sends. Answering it with "no such method" makes some clients log
    // an error on every connect.
    if method == ATTACH_METHOD {
        peer.token = params
            .and_then(|p| p.get("token"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        return None;
    }

    let id = request.get("id").cloned()?;

    match method {
        "initialize" => Some(response(
            &id,
            &json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
            }),
        )),
        "ping" => Some(response(&id, &json!({}))),
        "tools/list" => {
            Some(response(&id, &json!({ "tools": tools.list(peer.token.as_deref()).await })))
        }
        "tools/call" => {
            let Some(name) = params.and_then(|p| p.get("name")).and_then(Value::as_str) else {
                return Some(failure(&id, -32602, "tools/call needs a string `name`."));
            };
            let arguments = params
                .and_then(|p| p.get("arguments"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            let result = tools.call(peer.token.as_deref(), name, arguments).await;
            Some(response(
                &id,
                &match result {
                    Ok(value) => ok_result(&value),
                    Err(message) => error_result(&message),
                },
            ))
        }
        other => Some(failure(&id, -32601, &format!("No such method: {other}."))),
    }
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/// Pump newline-delimited JSON-RPC over one connection until the client hangs
/// up.
///
/// Frames are answered **in order, one at a time**. An agent calls tools
/// serially anyway, and serving them serially is free backpressure: a confused
/// model cannot open fifty concurrent hops into the webview, and the session's
/// call budget stays a meaningful number rather than a racing one.
async fn pump<R, W>(tools: &dyn Tools, reader: R, mut writer: W) -> std::io::Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let mut peer = Peer::default();
    let mut lines = BufReader::new(reader).lines();

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let answer = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle(tools, &mut peer, &request).await,
            // Nothing to correlate a parse failure with, so `id` is null —
            // JSON-RPC 2.0 §5 says exactly that.
            Err(error) => Some(failure(&Value::Null, -32700, &error.to_string())),
        };
        if let Some(answer) = answer {
            writer.write_all(format!("{answer}\n").as_bytes()).await?;
            writer.flush().await?;
        }
    }
    Ok(())
}

/// Serve one connected client. Split out so the transports below share it.
async fn serve<S>(app: AppHandle, stream: S)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + 'static,
{
    let state = app.state::<McpState>();
    let live = Live { app: &app, state: &state };
    let (reader, writer) = tokio::io::split(stream);
    if let Err(error) = pump(&live, reader, writer).await {
        log::debug!("[mcp] client ended: {error}");
    }
}

// ---------------------------------------------------------------------------
// Transport: unix
// ---------------------------------------------------------------------------

/// Where the running app listens.
///
/// Per user without a lookup: macOS gives each user its own `TMPDIR`, and
/// elsewhere `$USER` disambiguates a shared `/tmp`.
#[cfg(unix)]
#[must_use]
pub fn socket_path() -> std::path::PathBuf {
    let user = std::env::var("USER").unwrap_or_else(|_| "default".into());
    std::env::temp_dir().join(format!("microflow-mcp-{user}.sock"))
}

/// Start accepting MCP clients.
///
/// # Errors
/// When the socket cannot be bound. The caller logs it and carries on: an
/// agent CLI losing its way in is never a reason the desktop app refuses to
/// start.
#[cfg(unix)]
pub fn listen(app: AppHandle) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    let path = socket_path();

    // A socket file outlives the process that made it, and `bind` fails on an
    // existing path — but so would stealing the socket of a second Microflow
    // that is genuinely running. Probe before unlinking: a connect that
    // succeeds means someone is home, and this instance stays out of the way.
    if path.exists() {
        if std::os::unix::net::UnixStream::connect(&path).is_ok() {
            log::info!("[mcp] another Microflow already owns {}", path.display());
            return Ok(());
        }
        let _ = std::fs::remove_file(&path);
    }

    // Bind with `std`, adopt into tokio inside the task: `setup` runs on the
    // main thread with no reactor entered, and tokio's own `bind` panics there.
    let listener = std::os::unix::net::UnixListener::bind(&path)?;
    listener.set_nonblocking(true)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    app.state::<McpState>().set_listening();
    log::info!("[mcp] listening on {}", path.display());

    tauri::async_runtime::spawn(async move {
        let listener = match UnixListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                log::warn!("[mcp] not listening: {error}");
                return;
            }
        };
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(serve(app, stream));
                }
                // A failed accept is per-connection (fd limits, an interrupted
                // syscall); the listener is still good, so keep serving.
                Err(error) => log::warn!("[mcp] accept failed: {error}"),
            }
        }
    });
    Ok(())
}

/// `microflow --mcp <token>`: pipe this process's stdio to the running app.
///
/// Runs before Tauri, so `single_instance` never sees a second app. Sync
/// `std::io` on purpose — it is two `copy` calls and has no runtime to start.
///
/// # Errors
/// When nothing is listening (the app is not running), or the pipe breaks.
#[cfg(unix)]
pub fn relay(token: &str) -> std::io::Result<()> {
    use std::os::unix::net::UnixStream;

    let mut socket = UnixStream::connect(socket_path())?;
    write_attach(&mut socket, token)?;
    let mut inbound = socket.try_clone()?;
    let downstream = std::thread::spawn(move || std::io::copy(&mut inbound, &mut std::io::stdout()));
    std::io::copy(&mut std::io::stdin(), &mut socket)?;
    // The client closed its end; let anything already in flight land.
    socket.shutdown(std::net::Shutdown::Write)?;
    let _ = downstream.join();
    Ok(())
}

// ---------------------------------------------------------------------------
// Transport: windows
// ---------------------------------------------------------------------------

/// The named pipe the running app listens on. Windows namespaces pipes per
/// machine, not per user, so the user name is in the name.
#[cfg(windows)]
#[must_use]
pub fn pipe_name() -> String {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".into());
    format!(r"\\.\pipe\microflow-mcp-{user}")
}

/// Start accepting MCP clients.
///
/// Unlike a unix socket a named pipe serves one client per instance, so the
/// loop creates the next server before handing the connected one off — the
/// standard Windows accept shape, and what keeps a second CLI from finding
/// nothing listening while the first is mid-call.
///
/// # Errors
/// When the pipe cannot be created.
#[cfg(windows)]
pub fn listen(app: AppHandle) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;

    let name = pipe_name();

    // Created inside the task, not here: `setup` runs on the main thread with
    // no reactor entered, and `ServerOptions::create` panics there.
    tauri::async_runtime::spawn(async move {
        // `first_pipe_instance` is the same probe the unix side does by
        // connecting: it fails if some other process already owns this name,
        // which means another Microflow is running and this instance stays out
        // of the way.
        let mut server = match ServerOptions::new().first_pipe_instance(true).create(&name) {
            Ok(server) => server,
            Err(error) => {
                log::info!("[mcp] not listening on {name}: {error}");
                return;
            }
        };
        app.state::<McpState>().set_listening();
        log::info!("[mcp] listening on {name}");
        loop {
            if let Err(error) = server.connect().await {
                log::warn!("[mcp] pipe connect failed: {error}");
            }
            let connected = server;
            server = match ServerOptions::new().create(&name) {
                Ok(next) => next,
                Err(error) => {
                    log::error!("[mcp] could not reopen the pipe: {error}");
                    return;
                }
            };
            tauri::async_runtime::spawn(serve(app.clone(), connected));
        }
    });
    Ok(())
}

/// `microflow.exe --mcp <token>`: pipe this process's stdio to the running app.
///
/// A release build is a GUI-subsystem binary with no console of its own, which
/// does not matter here: the MCP client spawning us hands us pipes as stdin and
/// stdout, and inherited handles work with or without a console.
///
/// # Errors
/// When nothing is listening (the app is not running), or the pipe breaks.
#[cfg(windows)]
pub fn relay(token: &str) -> std::io::Result<()> {
    use std::fs::OpenOptions;
    use std::io::Write;

    let mut pipe = OpenOptions::new().read(true).write(true).open(pipe_name())?;
    write_attach(&mut pipe, token)?;
    let mut inbound = pipe.try_clone()?;
    let downstream = std::thread::spawn(move || std::io::copy(&mut inbound, &mut std::io::stdout()));
    std::io::copy(&mut std::io::stdin(), &mut pipe)?;
    drop(pipe);
    let _ = downstream.join();
    Ok(())
}

#[cfg(any(unix, windows))]
fn write_attach(writer: &mut impl std::io::Write, token: &str) -> std::io::Result<()> {
    let frame = json!({ "jsonrpc": "2.0", "method": ATTACH_METHOD, "params": { "token": token } });
    writeln!(writer, "{frame}")?;
    writer.flush()
}

// Neither unix nor windows: no server, and a relay that says so rather than
// pretending. Nothing else in the app changes — a CLI provider simply has no
// flow tools there, which `browser-support.ts` already knows how to say.
#[cfg(not(any(unix, windows)))]
pub fn listen(_app: AppHandle) -> std::io::Result<()> {
    Ok(())
}

#[cfg(not(any(unix, windows)))]
pub fn relay(_token: &str) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Microflow's MCP server is only available on macOS, Linux and Windows",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A roster with no app behind it: enough to drive every frame a client
    /// sends before, and including, its first tool call.
    struct Fake;

    #[async_trait::async_trait]
    impl Tools for Fake {
        async fn list(&self, token: Option<&str>) -> Vec<Value> {
            // Mirrors the real gate: unauthorised sees nothing at all.
            if token == Some("good") {
                vec![json!({ "name": "get_flow", "description": "d", "inputSchema": {} })]
            } else {
                Vec::new()
            }
        }

        async fn call(
            &self,
            token: Option<&str>,
            name: &str,
            arguments: Value,
        ) -> Result<Value, String> {
            if token != Some("good") {
                return Err("no Ask AI turn is open".into());
            }
            Ok(json!({ "ran": name, "with": arguments }))
        }
    }

    /// Run `frames` through the wire and collect what came back.
    async fn exchange(frames: &[Value]) -> Vec<Value> {
        let mut input = String::new();
        for frame in frames {
            use std::fmt::Write;
            let _ = writeln!(input, "{frame}");
        }
        let mut output: Vec<u8> = Vec::new();
        pump(&Fake, input.as_bytes(), &mut output).await.unwrap();
        String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn request(id: i64, method: &str, params: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    }

    fn attach(token: &str) -> Value {
        json!({ "jsonrpc": "2.0", "method": ATTACH_METHOD, "params": { "token": token } })
    }

    #[tokio::test]
    async fn a_client_can_initialize_list_and_call() {
        let replies = exchange(&[
            attach("good"),
            request(1, "initialize", json!({})),
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            request(2, "tools/list", json!({})),
            request(3, "tools/call", json!({ "name": "get_flow", "arguments": { "a": 1 } })),
        ])
        .await;

        // Four frames in that carry an id, four replies — the attach and the
        // `initialized` notification are answered with silence, as they must be.
        assert_eq!(replies.len(), 3);
        assert_eq!(replies[0]["result"]["serverInfo"]["name"], json!(SERVER_NAME));
        assert_eq!(replies[1]["result"]["tools"][0]["name"], json!("get_flow"));
        assert_eq!(replies[2]["result"]["isError"], json!(false));
        assert_eq!(
            replies[2]["result"]["content"][0]["text"],
            json!(r#"{"ran":"get_flow","with":{"a":1}}"#)
        );
    }

    #[tokio::test]
    async fn a_client_that_never_attaches_sees_nothing_and_can_do_nothing() {
        let replies = exchange(&[
            request(1, "tools/list", json!({})),
            request(2, "tools/call", json!({ "name": "get_flow" })),
        ])
        .await;

        assert_eq!(replies[0]["result"]["tools"], json!([]));
        // A refusal, not a protocol error: the model reads it.
        assert_eq!(replies[1]["result"]["isError"], json!(true));
        assert!(replies[1]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("no Ask AI turn"));
    }

    #[tokio::test]
    async fn a_bad_frame_does_not_end_the_connection() {
        let mut output: Vec<u8> = Vec::new();
        let input = format!(
            "not json\n\n{}\n",
            request(7, "ping", json!({}))
        );
        pump(&Fake, input.as_bytes(), &mut output).await.unwrap();

        let replies: Vec<Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        // Parse error with a null id (JSON-RPC 2.0 §5), a skipped blank line,
        // and then the client carries on.
        assert_eq!(replies[0]["error"]["code"], json!(-32700));
        assert_eq!(replies[0]["id"], Value::Null);
        assert_eq!(replies[1]["id"], json!(7));
    }

    #[tokio::test]
    async fn a_call_with_no_name_is_a_protocol_error_not_a_tool_error() {
        let replies = exchange(&[attach("good"), request(1, "tools/call", json!({}))]).await;
        // Nothing was called, so there is no tool result to put it in.
        assert_eq!(replies[0]["error"]["code"], json!(-32602));
    }

    #[tokio::test]
    async fn an_unknown_method_is_named() {
        let replies = exchange(&[request(1, "tools/subscribe", json!({}))]).await;
        assert_eq!(replies[0]["error"]["code"], json!(-32601));
        assert!(replies[0]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("tools/subscribe"));
    }

    #[test]
    fn a_refusal_is_a_tool_result_not_a_protocol_error() {
        // The model has to be able to read it and try something else, which a
        // JSON-RPC error does not reach.
        let result = error_result("no Ask AI turn is open");
        assert_eq!(result["isError"], json!(true));
        assert_eq!(result["content"][0]["text"], json!("no Ask AI turn is open"));
    }

    #[test]
    fn tool_output_reaches_the_model_as_text() {
        let result = ok_result(&json!({ "nodes": [] }));
        assert_eq!(result["isError"], json!(false));
        assert_eq!(result["content"][0]["text"], json!(r#"{"nodes":[]}"#));
    }
}
