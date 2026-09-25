//! Vertical-boundary guard for `nodes/` (ADR-0026 § Enforcement) — the Rust
//! twin of the web app's `architecture.test.ts`.
//!
//! `nodes` is `pub(crate)`, so the compiler already keeps every other crate out
//! of a Node's internals. It cannot tell one Node from another inside this
//! crate, though. These tests read the crate's own source and fail when:
//!
//! 1. a Node's code names another Node (`crate::nodes::<other>`,
//!    `super::super::<other>`). Nodes do not depend on each other: what two
//!    Nodes share belongs in `runtime/`, `codegen/` or `config/`. A Node reaches
//!    its own layers through `super::`, never through `crate::nodes::<self>`;
//! 2. a file outside `nodes/` names a Node and is not one of the central
//!    dispatch tables in [`CENTRAL_DISPATCH`] (ADR-0012);
//! 3. `nodes/mod.rs` and the `nodes/<node>/` directories disagree, `nodes/`
//!    holds a loose file, or a Node directory holds anything but its `mod.rs`
//!    and its declared layers.
//!
//! Comments and the contents of string and char literals are blanked before
//! matching, so prose and doc links do not count as references.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// The files outside `nodes/` that may name a Node: the central, explicit
/// dispatch tables (ADR-0012, ADR-0026 D3), each with one line per Node. An
/// entry that no longer names a Node fails the guard, so this list cannot go
/// stale.
const CENTRAL_DISPATCH: &[(&str, &str)] = &[
    ("runtime/registry.rs", "`ComponentRegistry::register_all`: one builder per Node"),
    ("codegen/mod.rs", "`emit_node` / `output_expression`: one arm per Node"),
    ("codegen/validate.rs", "the pin tables: one arm per Node that owns pins"),
    ("codegen/parity.rs", "`classify` and the interpret-to-emit parity cases"),
];

/// The layer files a Node directory may hold, next to its `mod.rs` (ADR-0026 D1).
const LAYERS: &[&str] = &["config", "runtime", "codegen"];

/// This guard, the one module in `nodes/mod.rs` that is not a Node.
const GUARD_MODULE: &str = "boundaries";

/// Where to put code that more than one Node needs.
const SHARED_HOME: &str =
    "`runtime/` (engine), `codegen/` (emitter helpers) or `config/` (serde helpers)";

/// One `.rs` file of the crate.
struct SourceFile {
    /// Path relative to `src/`, `/`-separated.
    path: String,
    /// The source with comments removed and literal contents blanked.
    code: String,
}

fn src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn nodes_dir() -> PathBuf {
    src_dir().join("nodes")
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// The entries of `dir` as `(name, is_dir)`, sorted by name.
fn entries(dir: &Path) -> Vec<(String, bool)> {
    let mut entries: Vec<(String, bool)> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
        .map(|entry| {
            let entry = entry.expect("readable directory entry");
            (entry.file_name().to_string_lossy().into_owned(), entry.path().is_dir())
        })
        .collect();
    entries.sort();
    entries
}

/// Every `.rs` file under `src/`, sorted by path.
fn source_files() -> Vec<SourceFile> {
    fn walk(dir: &Path, prefix: &str, out: &mut Vec<SourceFile>) {
        for (name, is_dir) in entries(dir) {
            let path = format!("{prefix}{name}");
            if is_dir {
                walk(&dir.join(&name), &format!("{path}/"), out);
            } else if Path::new(&name).extension().is_some_and(|ext| ext == "rs") {
                out.push(SourceFile { code: strip(&read(&dir.join(&name))), path });
            }
        }
    }
    let mut files = Vec::new();
    walk(&src_dir(), "", &mut files);
    files
}

/// The Node directories under `nodes/`.
fn node_dirs() -> BTreeSet<String> {
    entries(&nodes_dir())
        .into_iter()
        .filter_map(|(name, is_dir)| is_dir.then_some(name))
        .collect()
}

/// The Node that owns `path` (`nodes/<node>/…`), if any.
fn owning_node(path: &str) -> Option<&str> {
    path.strip_prefix("nodes/")?.split_once('/').map(|(node, _)| node)
}

/// If a raw string literal (`r"…"`, `r#"…"#`, `br"…"`) starts at `chars[i]`,
/// the number of `#`s that close it. A raw identifier (`r#loop`) is not one.
fn raw_string_hashes(chars: &[char], i: usize) -> Option<usize> {
    let at = |j: usize| chars.get(j).copied();
    let ident_at =
        |j: Option<usize>| j.and_then(at).is_some_and(|c| c.is_alphanumeric() || c == '_');
    let starts_token = !ident_at(i.checked_sub(1))
        || (i.checked_sub(1).and_then(at) == Some('b') && !ident_at(i.checked_sub(2)));
    if at(i) != Some('r') || !starts_token {
        return None;
    }
    let hashes = chars[i + 1..].iter().take_while(|&&c| c == '#').count();
    (at(i + 1 + hashes) == Some('"')).then_some(hashes)
}

/// `text` with comments removed and the contents of string and char literals
/// blanked. Newlines are kept, so a byte offset still maps to its line.
fn strip(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let at = |i: usize| chars.get(i).copied();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while let Some(c) = at(i) {
        if c == '/' && at(i + 1) == Some('/') {
            while at(i).is_some_and(|c| c != '\n') {
                i += 1;
            }
        } else if c == '/' && at(i + 1) == Some('*') {
            // Block comments nest in Rust.
            let mut depth = 0usize;
            while let Some(c) = at(i) {
                if c == '/' && at(i + 1) == Some('*') {
                    depth += 1;
                    i += 2;
                } else if c == '*' && at(i + 1) == Some('/') {
                    depth -= 1;
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    if c == '\n' {
                        out.push('\n');
                    }
                    i += 1;
                }
            }
        } else if c == '"' {
            i += 1;
            while at(i).is_some_and(|c| c != '"') {
                if at(i) == Some('\\') {
                    i += 1;
                }
                if at(i) == Some('\n') {
                    out.push('\n');
                }
                i += 1;
            }
            out.push_str("\"\"");
            i += 1;
        } else if let Some(hashes) = raw_string_hashes(&chars, i) {
            // Ends at the first `"` followed by as many `#`s.
            i += hashes + 2;
            while let Some(c) = at(i) {
                if c == '"' && (1..=hashes).all(|k| at(i + k) == Some('#')) {
                    i += hashes + 1;
                    break;
                }
                if c == '\n' {
                    out.push('\n');
                }
                i += 1;
            }
            out.push_str("\"\"");
        } else if c == '\'' && at(i + 1) == Some('\\') {
            // Escaped char literal: `'\''`, `'\n'`, `'\u{…}'`.
            i += 3;
            while at(i).is_some_and(|c| c != '\'') {
                i += 1;
            }
            out.push_str("' '");
            i += 1;
        } else if c == '\'' && at(i + 2) == Some('\'') {
            out.push_str("' '");
            i += 3;
        } else {
            // Code, including a lifetime or label (`'a`).
            out.push(c);
            i += 1;
        }
    }
    out
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// The 1-based line of byte offset `at`.
fn line_of(code: &str, at: usize) -> usize {
    code[..at].matches('\n').count() + 1
}

/// The leading path segment of `s`: an identifier, or `*` for a glob.
fn head(s: &str) -> Option<String> {
    let s = s.trim_start();
    if s.starts_with('*') {
        return Some("*".to_string());
    }
    let end = s.find(|c: char| !(c.is_alphanumeric() || c == '_')).unwrap_or(s.len());
    (end > 0).then(|| s[..end].to_string())
}

/// The segments a path continues with after a `::`: one for `x::…`, one per
/// element of a `{a, b::c}` group. `self` is left out: it is not a Node.
fn heads_after(rest: &str) -> Vec<String> {
    let rest = rest.trim_start();
    let Some(group) = rest.strip_prefix('{') else {
        return head(rest).filter(|h| h != "self").into_iter().collect();
    };
    let mut heads = Vec::new();
    let (mut depth, mut start) = (0usize, 0usize);
    for (i, c) in group.char_indices() {
        match c {
            '{' => depth += 1,
            '}' if depth == 0 => {
                heads.extend(head(&group[start..i]));
                break;
            }
            '}' => depth -= 1,
            ',' if depth == 0 => {
                heads.extend(head(&group[start..i]));
                start = i + 1;
            }
            _ => {}
        }
    }
    heads.retain(|h| h != "self");
    heads
}

/// Every whole `word` in `code` that is followed by `::`, as the byte offset of
/// the word and the text after the `::`.
fn path_segments<'a>(code: &'a str, word: &str) -> Vec<(usize, &'a str)> {
    let bytes = code.as_bytes();
    code.match_indices(word)
        .filter(|&(at, _)| at == 0 || !is_ident_byte(bytes[at - 1]))
        .filter_map(|(at, _)| {
            let rest = code[at + word.len()..].trim_start().strip_prefix("::")?;
            Some((at, rest))
        })
        .collect()
}

/// Every `nodes::<name>` path in `code` as `(line, name)`: `crate::nodes::x`,
/// each head of a `nodes::{a, b::c}` group, and `*` for `nodes::*`.
fn nodes_paths(code: &str) -> Vec<(usize, String)> {
    let mut paths = Vec::new();
    for (at, rest) in path_segments(code, "nodes") {
        let line = line_of(code, at);
        paths.extend(heads_after(rest).into_iter().map(|name| (line, name)));
    }
    paths
}

/// Every `super::…::<name>` path in `code` as `(line, name)`, where `name` is
/// the segment after the last `super::`.
fn super_paths(code: &str) -> Vec<(usize, String)> {
    let mut paths = Vec::new();
    for (at, mut rest) in path_segments(code, "super") {
        // Only the first `super` of a chain; the rest are walked from it.
        if code[..at].trim_end().ends_with("::") {
            continue;
        }
        while let Some(next) = rest.trim_start().strip_prefix("super") {
            match next.trim_start().strip_prefix("::") {
                Some(after) => rest = after,
                None => break,
            }
        }
        let line = line_of(code, at);
        paths.extend(heads_after(rest).into_iter().map(|name| (line, name)));
    }
    paths
}

/// The modules `code` declares from their own file (`mod <name>;`, any
/// visibility or `cfg`). Inline `mod <name> { … }` blocks are not files.
fn declared_mods(code: &str) -> BTreeSet<String> {
    let bytes = code.as_bytes();
    code.match_indices("mod")
        .filter(|&(at, _)| {
            (at == 0 || !is_ident_byte(bytes[at - 1]))
                && bytes.get(at + 3).is_some_and(u8::is_ascii_whitespace)
        })
        .filter_map(|(at, _)| {
            let rest = &code[at + 3..];
            let name = head(rest)?;
            let after = rest.trim_start()[name.len()..].trim_start();
            after.starts_with(';').then_some(name)
        })
        .collect()
}

#[track_caller]
fn assert_none(rule: &str, violations: &[String]) {
    assert!(violations.is_empty(), "\n{rule}\n\n  {}\n", violations.join("\n  "));
}

#[test]
fn the_scanner_reads_code_not_prose_or_literals() {
    let code = strip(concat!(
        "//! [`crate::nodes::led::runtime`] /* nodes::relay */\n",
        "/* crate::nodes::relay /* nested */ nodes::relay */ let s = \"crate::nodes::servo\";\n",
        "let r = br#\"nodes::rgb \" nodes::led\"#; let c = '\"'; let e = '\\''; fn f<'a>() {}\n",
        "use crate::nodes::{button::runtime::Button, self, gate};\n",
        "use super::super::pixel::config; pub(super) fn g() {}\n",
        "pub(crate) mod led;\n#[cfg(test)]\nmod tests {}\n",
    ));
    let at = |line: usize, name: &str| (line, name.to_string());
    assert_eq!(nodes_paths(&code), vec![at(4, "button"), at(4, "gate")]);
    assert_eq!(super_paths(&code), vec![at(5, "pixel")]);
    assert_eq!(declared_mods(&code), BTreeSet::from(["led".to_string()]));
    assert_eq!(code.lines().count(), 8, "line numbers survive stripping");
}

#[test]
fn nodes_do_not_depend_on_each_other() {
    let nodes = node_dirs();
    let mut violations = Vec::new();
    for file in source_files() {
        let Some(own) = owning_node(&file.path) else { continue };
        let path = &file.path;
        let depends = |name: &str| format!("Node `{own}` depends on Node `{name}`");
        for (line, name) in nodes_paths(&file.code) {
            violations.push(if name == own {
                format!(
                    "src/{path}:{line}: `nodes::{name}` — reach this Node's own layers \
                     through `super::` (e.g. `super::config`), not `crate::nodes`"
                )
            } else {
                format!("src/{path}:{line}: `nodes::{name}` — {}", depends(&name))
            });
        }
        for (line, name) in super_paths(&file.code) {
            if name != own && nodes.contains(&name) {
                violations.push(format!("src/{path}:{line}: `super::…::{name}` — {}", depends(&name)));
            }
        }
    }
    assert_none(
        &format!(
            "Nodes must not depend on each other (ADR-0026). Move what both Nodes need into \
             {SHARED_HOME} and reach it through `crate::`."
        ),
        &violations,
    );
}

#[test]
fn only_the_central_dispatch_tables_name_a_node() {
    let mut violations = Vec::new();
    let mut naming = BTreeSet::new();
    for file in source_files() {
        if owning_node(&file.path).is_some() {
            continue;
        }
        let refs = nodes_paths(&file.code);
        if refs.is_empty() {
            continue;
        }
        if CENTRAL_DISPATCH.iter().any(|&(central, _)| central == file.path) {
            naming.insert(file.path);
            continue;
        }
        for (line, name) in refs {
            violations.push(format!("src/{}:{line}: `nodes::{name}`", file.path));
        }
    }
    for &(central, why) in CENTRAL_DISPATCH {
        if !naming.contains(central) {
            violations.push(format!(
                "src/{central}: listed in CENTRAL_DISPATCH ({why}) but names no Node any more — \
                 remove the entry"
            ));
        }
    }
    assert_none(
        "Only the central dispatch tables may name a Node (ADR-0012, ADR-0026 D3). Move the \
         Node-specific code into its `nodes/<node>/`. If the file really is a new central table \
         (one explicit line per Node), add it to CENTRAL_DISPATCH in `nodes/boundaries.rs` with \
         its reason.",
        &violations,
    );
}

#[test]
fn the_node_index_matches_the_node_directories() {
    let index = declared_mods(&strip(&read(&nodes_dir().join("mod.rs"))));
    let mut violations = Vec::new();
    for (name, is_dir) in entries(&nodes_dir()) {
        if is_dir && !index.contains(&name) {
            violations.push(format!(
                "src/nodes/{name}/ is missing from `nodes/mod.rs`, so it is never compiled — \
                 add `pub(crate) mod {name};`"
            ));
        } else if !is_dir && !matches!(name.strip_suffix(".rs"), Some("mod" | GUARD_MODULE)) {
            violations.push(format!(
                "src/nodes/{name} is not a Node directory — make it `nodes/<node>/`, or move \
                 shared code to {SHARED_HOME}"
            ));
        }
    }
    let dirs = node_dirs();
    for name in index.iter().filter(|&name| name != GUARD_MODULE && !dirs.contains(name)) {
        violations.push(format!(
            "`nodes/mod.rs` declares `mod {name};` but there is no src/nodes/{name}/ directory — \
             `nodes/` holds only Node directories; shared code goes to {SHARED_HOME}"
        ));
    }
    assert_none("`nodes/mod.rs` lists exactly the Node directories (ADR-0026 D1).", &violations);
}

#[test]
fn a_node_directory_holds_only_its_layers() {
    let mut violations = Vec::new();
    for node in node_dirs() {
        let dir = nodes_dir().join(&node);
        let mut layers = BTreeSet::new();
        let mut has_index = false;
        for (name, is_dir) in entries(&dir) {
            match name.strip_suffix(".rs") {
                Some("mod") if !is_dir => has_index = true,
                Some(layer) if !is_dir && LAYERS.contains(&layer) => {
                    layers.insert(layer.to_string());
                }
                _ => violations.push(format!(
                    "src/nodes/{node}/{name} is not a layer — a Node directory holds `mod.rs` \
                     plus `config.rs`, `runtime.rs` and/or `codegen.rs`; shared code goes to \
                     {SHARED_HOME}"
                )),
            }
        }
        if !has_index {
            violations.push(format!("src/nodes/{node}/ has no `mod.rs`"));
            continue;
        }
        let declared = declared_mods(&strip(&read(&dir.join("mod.rs"))));
        for layer in layers.difference(&declared) {
            violations.push(format!(
                "src/nodes/{node}/{layer}.rs is not declared in `nodes/{node}/mod.rs`, so it is \
                 never compiled — add `pub(crate) mod {layer};` behind its feature gate"
            ));
        }
    }
    assert_none("A Node directory holds its `mod.rs` and its layers (ADR-0026 D1).", &violations);
}
