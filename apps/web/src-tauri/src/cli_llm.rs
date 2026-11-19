//! Local agent CLIs as an LLM provider (desktop only).
//!
//! Claude Code, opencode and pi are already installed on the user's machine and
//! already hold that user's model credentials. None of them speaks the `OpenAI`
//! wire protocol the rest of the LLM transport is built on (ADR-0021) and none
//! exposes an HTTP server, so the only way to reach them is to run the binary.
//! That is a subprocess, which the browser host cannot do — these providers are
//! desktop-only, and the webview's `tauri-agent-cli.ts` is the one caller.
//!
//! ## Why an allowlist
//!
//! The binary name arrives from the webview, which reads it from a provider
//! entry persisted in `localStorage`. Passing that straight to `Command::new`
//! would turn any script injected into the page into arbitrary code execution.
//! The name is therefore matched against [`ALLOWED`] and the arguments are
//! passed as a vector — never through a shell — so no argument can start a
//! second command.
//!
//! ## Who ends a process
//!
//! Every process started here is started through [`AgentCliRuns`] ([`runs`]),
//! which owns it until it has ended: a generation and a model listing alike.
//! The webview names a generation's run and stops it by that name
//! ([`llm_cli_stop`]) when its turn is stopped. A page that is gone cannot do
//! that, so [`page_gone`] ends every run for it, and [`quit`] does when the
//! app exits.

pub mod runs;

use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tokio::process::Command;

pub use runs::AgentCliRuns;
use runs::{Ended, Failure};

/// The CLIs that may be spawned, by bare binary name. Mirrors `CLI_PROVIDERS`
/// in `apps/web/src/ai/cli-providers.ts`; adding one means adding it in
/// both places, deliberately — a new entry is a new thing this app may execute.
const ALLOWED: &[&str] = &["claude", "codex", "copilot", "gemini", "opencode", "pi"];

/// Where these CLIs install themselves, beyond whatever `PATH` we inherited.
///
/// A macOS app launched from Finder gets the bare `launchd` `PATH`
/// (`/usr/bin:/bin:/usr/sbin:/sbin`) rather than the login shell's, so every
/// one of these — installed under `$HOME` by their own installers or a Node
/// version manager — is invisible to a plain `Command::new("claude")`. Rather
/// than run the user's shell to learn its `PATH` (slow, and it runs their
/// rc files), look where the installers actually put things.
fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(path) = std::env::var("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for suffix in [".local/bin", ".opencode/bin", ".bun/bin", ".npm-global/bin"] {
            dirs.push(home.join(suffix));
        }
        // Node version managers keep one bin dir per installed version; a
        // globally installed `pi` lives in whichever is current. Cheap to scan.
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            for entry in entries.flatten() {
                dirs.push(entry.path().join("bin"));
            }
        }
    }
    dirs.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
    dirs
}

/// Resolve an allowlisted CLI to an absolute path, or explain why not.
fn resolve(bin: &str) -> Result<PathBuf, String> {
    if !ALLOWED.contains(&bin) {
        return Err(format!("{bin} is not a supported local CLI"));
    }
    candidate_dirs()
        .into_iter()
        .map(|dir| dir.join(bin))
        .find(|path| path.is_file())
        .ok_or_else(|| format!("{bin} was not found — install it, or check it is on your PATH"))
}

/// Report whether a local CLI is installed. Backs the config page's status dot,
/// which for an HTTP provider probes `/models`; for a CLI "reachable" can only
/// mean "the binary exists".
#[tauri::command]
pub async fn llm_cli_probe(bin: String) -> Result<String, String> {
    resolve(&bin).map(|path| path.to_string_lossy().into_owned())
}

/// Run an allowlisted CLI once, as the run `name`, and collect what it printed.
///
/// `stdin` is written and the pipe closed before waiting — without the close
/// these CLIs sit waiting for more input. `merge_stderr` exists because model
/// listings do not agree on which stream they are: `opencode models` writes to
/// stdout, `pi --list-models` to stderr. A generation must never merge them, or
/// a progress spinner ends up inside the answer.
///
/// A run that was stopped is an error here like any other, and carries nothing
/// the process printed. Whoever stopped it is not reading the answer.
async fn run_once(
    runs: &AgentCliRuns,
    name: &str,
    bin: &str,
    args: &[String],
    stdin: &str,
    merge_stderr: bool,
) -> Result<String, String> {
    let path = resolve(bin)?;

    let mut command = Command::new(&path);
    command.args(args);
    let output = match runs.run(name, command, stdin.as_bytes()).await {
        Ok(Ended::Exited(output)) => output,
        Ok(Ended::Stopped) => return Err(format!("{bin} was stopped")),
        Err(Failure::Start(e)) => return Err(format!("could not start {bin}: {e}")),
        Err(Failure::Stdin(e)) => {
            return Err(format!("could not send the prompt to {bin}: {e}"))
        }
        Err(Failure::Wait(e)) => return Err(format!("{bin} failed: {e}")),
    };

    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            format!("{bin} exited with {}", output.status)
        } else {
            format!("{bin}: {detail}")
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(if merge_stderr {
        format!("{stdout}\n{stderr}").trim().to_string()
    } else {
        stdout.trim().to_string()
    })
}

/// Run one prompt through a local CLI in its non-interactive print mode and
/// return everything it wrote to stdout.
///
/// The prompt goes over stdin, never as an argument: these prompts routinely
/// carry newlines and the whole node catalogue (Ask AI's system prompt), and an
/// argument list has a hard size limit that a flow description will exceed.
///
/// Non-streaming — one call, one string. The CLIs do stream stdout, but a Tauri
/// command resolves once; carrying deltas would need an `ipc::Channel` and a
/// second path through the adapter.
///
/// `run` is the name the webview gave this run. It is what [`llm_cli_stop`]
/// ends the process by, so it is new for every call.
// ponytail: one-shot; add a tauri::ipc::Channel here (carried by `AgentCliPort.run`
// in tauri-agent-cli.ts, driving TEXT_MESSAGE_CONTENT in cli-adapter.ts) if the
// wait without visible output proves too long.
#[tauri::command]
pub async fn llm_cli_generate(
    run: String,
    bin: String,
    args: Vec<String>,
    prompt: String,
    runs: tauri::State<'_, AgentCliRuns>,
) -> Result<String, String> {
    run_once(&runs, &run, &bin, &args, &prompt, false).await
}

/// End the process of the run `run`, and everything that process started.
///
/// A run that is over is not affected, and no other run is. A run that has not
/// started yet is not started (see [`AgentCliRuns::stop`]).
///
/// `async` so it runs off the main thread: a stop waits for a run that is
/// being started at the same moment.
#[tauri::command]
pub async fn llm_cli_stop(
    run: String,
    runs: tauri::State<'_, AgentCliRuns>,
) -> Result<(), String> {
    runs.stop(&run);
    Ok(())
}

/// Ask a local CLI which models it can reach, as raw output for the webview to
/// parse (each CLI has its own format — see `listModels` in
/// `ai/cli-providers.ts`, which is where the parsing lives so it is
/// testable without a subprocess).
///
/// The webview has no name for a listing and never stops one. It is named here
/// so the process still has an owner when the page is gone or the app quits.
#[tauri::command]
pub async fn llm_cli_models(
    bin: String,
    args: Vec<String>,
    runs: tauri::State<'_, AgentCliRuns>,
) -> Result<String, String> {
    let name = format!("models-{}", uuid::Uuid::new_v4());
    run_once(&runs, &name, &bin, &args, "", true).await
}

/// The page that asked for every run is gone: a reload, or a first load with
/// nothing running. End every agent CLI process, and close the Flow Tool Server
/// session the page had open, so a process that is still ending cannot edit the
/// flow of the page that replaced it.
///
/// The new page's own session cannot be the one closed: it opens a session
/// only after it has loaded and a turn has been sent, long after this runs.
pub fn page_gone(app: &AppHandle) {
    app.state::<AgentCliRuns>().stop_all();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        app.state::<crate::mcp::McpState>().end().await;
    });
}

/// The app is exiting: end every agent CLI process before it does. Blocks for
/// at most [`runs::STOP_GRACE`].
pub fn quit(app: &AppHandle) {
    app.state::<AgentCliRuns>().shutdown();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_anything_not_allowlisted() {
        // The store is localStorage; this is the guard that keeps a tampered
        // provider entry from becoming arbitrary code execution.
        assert!(resolve("sh").is_err());
        assert!(resolve("../../bin/sh").is_err());
        assert!(resolve("claude; rm -rf /").is_err());
    }
}
