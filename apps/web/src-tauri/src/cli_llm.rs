//! Local agent CLIs as an LLM provider (desktop only).
//!
//! Claude Code, opencode and pi are already installed on the user's machine and
//! already hold that user's model credentials. None of them speaks the `OpenAI`
//! wire protocol the rest of the LLM transport is built on (ADR-0021) and none
//! exposes an HTTP server, so the only way to reach them is to run the binary.
//! That is a subprocess, which the browser host cannot do — these providers are
//! desktop-only, and the webview's `cli-adapter.ts` is the one caller.
//!
//! ## Why an allowlist
//!
//! The binary name arrives from the webview, which reads it from a provider
//! entry persisted in `localStorage`. Passing that straight to `Command::new`
//! would turn any script injected into the page into arbitrary code execution.
//! The name is therefore matched against [`ALLOWED`] and the arguments are
//! passed as a vector — never through a shell — so no argument can start a
//! second command.

use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// The CLIs that may be spawned, by bare binary name. Mirrors `CLI_PROVIDERS`
/// in `apps/web/src/lib/ai/cli-providers.ts`; adding one means adding it in
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

/// Run an allowlisted CLI once and collect what it printed.
///
/// `stdin` is written and the pipe closed before waiting — without the close
/// these CLIs sit waiting for more input. `merge_stderr` exists because model
/// listings do not agree on which stream they are: `opencode models` writes to
/// stdout, `pi --list-models` to stderr. A generation must never merge them, or
/// a progress spinner ends up inside the answer.
async fn run(
    bin: &str,
    args: &[String],
    stdin: &str,
    merge_stderr: bool,
) -> Result<String, String> {
    let path = resolve(bin)?;

    let mut child = Command::new(&path)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start {bin}: {e}"))?;

    if let Some(mut pipe) = child.stdin.take() {
        pipe.write_all(stdin.as_bytes())
            .await
            .map_err(|e| format!("could not send the prompt to {bin}: {e}"))?;
        drop(pipe);
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("{bin} failed: {e}"))?;

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
// ponytail: one-shot; add a tauri::ipc::Channel here (and drive TEXT_MESSAGE_CONTENT
// from it in cli-adapter.ts) if the wait without visible output proves too long.
#[tauri::command]
pub async fn llm_cli_generate(
    bin: String,
    args: Vec<String>,
    prompt: String,
) -> Result<String, String> {
    run(&bin, &args, &prompt, false).await
}

/// Ask a local CLI which models it can reach, as raw output for the webview to
/// parse (each CLI has its own format — see `listModels` in
/// `lib/ai/cli-providers.ts`, which is where the parsing lives so it is
/// testable without a subprocess).
#[tauri::command]
pub async fn llm_cli_models(bin: String, args: Vec<String>) -> Result<String, String> {
    run(&bin, &args, "", true).await
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
