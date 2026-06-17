#!/usr/bin/env python3
"""WTF gh body helper (cross-platform).

Hardens every GitHub issue/PR *body* read and write against the encoding
corruption that bites `gh` on Windows. It is a CLI utility invoked by wtf
skills — NOT a settings.json hook. It rides along in the wtf.setup payload
next to track-interventions.py, and wtf.setup copies it into the consuming
repo at `.wtf/gh-body.py` so the guard travels with the repo for every
teammate (Windows included).

Three failure modes this prevents (all observed with `gh` under PowerShell):

  1. Console code page (CP850) mojibake — PowerShell renders `gh` output and
     encodes `gh` input through the console code page, so non-ASCII (emoji
     titles, accented domain language) round-trips to garbage.
  2. Newline collapse — `$body = gh issue view ...` captures multi-line output
     as a string array that joins lines with spaces, destroying the body.
  3. Inline `--body "..."` mojibake — non-ASCII in an inline argument is
     re-encoded by the shell before `gh` sees it.

Why Python fixes all three regardless of platform:

  * subprocess pipes are byte streams. We capture `gh` stdout as raw bytes and
    decode UTF-8 ourselves (never `text=True`, which would use the locale =
    CP850 = the bug). The console code page is bypassed entirely.
  * bodies are always passed via `--body-file`, written as UTF-8 WITHOUT a BOM
    (a BOM would embed `﻿` at the top of the issue body).
  * argv reaches the child through CreateProcessW (wide) on Windows, so emoji
    and accented titles/labels survive without a CP850 round-trip.

Subcommands
-----------
  read <number> [--pr] [--repo R]
      Fetch the issue/PR body, write it to a fresh UTF-8 temp file, and print
      that temp file's path to stdout. Read the file with the Read tool, edit
      it, then push it back with `edit`. NEVER capture a body into a shell
      variable — that is failure mode 2.

  create --title T --body-file F [--label L]... [--base B] [--pr] [--repo R]
      Create an issue (or a PR with --pr) from a body file, re-encoded UTF-8
      no-BOM. Prints the created URL (gh's own stdout).

  edit <number> --body-file F [--pr] [--repo R]
      Replace an issue/PR body from a body file, re-encoded UTF-8 no-BOM.

  comment <number> --body-file F [--pr] [--repo R]
      Add a comment to an issue (or PR with --pr) from a body file, re-encoded
      UTF-8 no-BOM. Use this for every comment — inline `--body "..."` is
      failure mode 3 above and mojibakes emoji/accents on Windows.

  review <number> --body-file F [--repo R] [--approve|--request-changes|--comment]
      Post a PR review from a body file, re-encoded UTF-8 no-BOM. The review
      verdict flag is forwarded to `gh pr review`.

  release <tag> --notes-file F [--title T] [--repo R]
      Create a GitHub release from a notes file, re-encoded UTF-8 no-BOM.

Any unrecognized flags are forwarded verbatim to the underlying `gh` command
(e.g. --assignee, --milestone, --add-reviewer), so the helper does not have to
enumerate every gh option.

Exit codes: 0 ok · 2 usage/input-missing · 3 input not valid UTF-8 ·
4 `gh` not found · otherwise gh's own exit code.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile


def eprint(*args):
    print(*args, file=sys.stderr)


def reconfigure_stdio():
    """Force this process's own stdout/stderr to UTF-8 so diagnostics and the
    printed path are correct even when launched from a CP850 console."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # Python 3.7+
        except Exception:
            pass


def find_gh():
    gh = shutil.which("gh")
    if not gh:
        eprint("gh-body: the GitHub CLI ('gh') was not found on PATH. Install it from https://cli.github.com.")
        sys.exit(4)
    return gh


def kind(is_pr):
    return "pr" if is_pr else "issue"


def normalize_newlines(text):
    return text.replace("\r\n", "\n").replace("\r", "\n")


def write_utf8_no_bom(text):
    """Write `text` to a fresh temp file as UTF-8 with LF newlines and no BOM.
    Returns the path. mkstemp guarantees a unique name, so parallel runs never
    collide — this supersedes the manual `$(date +%s)` uniqueness scheme."""
    fd, path = tempfile.mkstemp(prefix="wtf-ghbody-", suffix=".md")
    os.close(fd)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    return path


def read_input_utf8(path):
    """Read a body file the skill produced. `utf-8-sig` strips a leading BOM if
    some upstream tool added one; a hard UnicodeDecodeError means the file is
    genuinely not UTF-8 (e.g. CP850) — surface it loudly rather than ship
    mojibake."""
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            return normalize_newlines(fh.read())
    except FileNotFoundError:
        eprint(f"gh-body: body file not found: {path}")
        sys.exit(2)
    except UnicodeDecodeError:
        eprint(
            f"gh-body: '{path}' is not valid UTF-8 — it was likely written by a "
            "non-UTF-8 tool. Re-write the body as UTF-8 and retry."
        )
        sys.exit(3)


def run_gh(cmd):
    """Run gh capturing raw bytes; forward its streams verbatim; return rc."""
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.stderr:
        sys.stderr.buffer.write(proc.stderr)
        sys.stderr.buffer.flush()
    if proc.stdout:
        sys.stdout.buffer.write(proc.stdout)
        sys.stdout.buffer.flush()
    return proc.returncode


def cmd_read(args, extra):
    gh = find_gh()
    cmd = [gh, kind(args.pr), "view", str(args.number), "--json", "body", "-q", ".body"]
    if args.repo:
        cmd += ["--repo", args.repo]
    cmd += extra
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        if proc.stderr:
            sys.stderr.buffer.write(proc.stderr)
        return proc.returncode
    text = normalize_newlines(proc.stdout.decode("utf-8"))
    safe_num = re.sub(r"[^0-9A-Za-z]", "", str(args.number)) or "x"
    fd, path = tempfile.mkstemp(prefix=f"wtf-{kind(args.pr)}-{safe_num}-", suffix=".md")
    os.close(fd)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    n_lines = text.count("\n")
    n_chars = len(text)
    if n_chars > 200 and n_lines == 0:
        eprint("gh-body: WARNING — long body with no newlines; possible upstream corruption.")
    eprint(f"gh-body: wrote {n_chars} chars, {n_lines} newlines (UTF-8, no BOM) -> {path}")
    print(path)  # stdout: the path, and only the path
    return 0


def cmd_create(args, extra):
    gh = find_gh()
    body = read_input_utf8(args.body_file)
    tmp = write_utf8_no_bom(body)
    try:
        cmd = [gh, kind(args.pr), "create", "--title", args.title, "--body-file", tmp]
        for label in (args.label or []):
            cmd += ["--label", label]
        if args.base:
            if not args.pr:
                eprint("gh-body: --base is only valid with --pr; ignoring it for issue creation.")
            else:
                cmd += ["--base", args.base]
        if args.repo:
            cmd += ["--repo", args.repo]
        cmd += extra
        return run_gh(cmd)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def cmd_edit(args, extra):
    gh = find_gh()
    body = read_input_utf8(args.body_file)
    tmp = write_utf8_no_bom(body)
    try:
        cmd = [gh, kind(args.pr), "edit", str(args.number), "--body-file", tmp]
        if args.repo:
            cmd += ["--repo", args.repo]
        cmd += extra
        return run_gh(cmd)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def cmd_comment(args, extra):
    gh = find_gh()
    body = read_input_utf8(args.body_file)
    tmp = write_utf8_no_bom(body)
    try:
        cmd = [gh, kind(args.pr), "comment", str(args.number), "--body-file", tmp]
        if args.repo:
            cmd += ["--repo", args.repo]
        cmd += extra
        return run_gh(cmd)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def cmd_review(args, extra):
    gh = find_gh()
    body = read_input_utf8(args.body_file)
    tmp = write_utf8_no_bom(body)
    try:
        cmd = [gh, "pr", "review", str(args.number), "--body-file", tmp]
        if args.repo:
            cmd += ["--repo", args.repo]
        cmd += extra  # --approve / --request-changes / --comment
        return run_gh(cmd)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def cmd_release(args, extra):
    gh = find_gh()
    notes = read_input_utf8(args.notes_file)
    tmp = write_utf8_no_bom(notes)
    try:
        cmd = [gh, "release", "create", str(args.tag), "--notes-file", tmp]
        if args.title is not None:
            cmd += ["--title", args.title]
        if args.repo:
            cmd += ["--repo", args.repo]
        cmd += extra
        return run_gh(cmd)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def build_parser():
    parser = argparse.ArgumentParser(
        prog="gh-body",
        description="Cross-platform UTF-8-safe wrapper for GitHub issue/PR body read & write.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("read", help="fetch a body to a UTF-8 temp file; print its path")
    r.add_argument("number", help="issue or PR number")
    r.add_argument("--pr", action="store_true", help="target a PR instead of an issue")
    r.add_argument("--repo", help="OWNER/REPO (defaults to current repo)")

    c = sub.add_parser("create", help="create an issue/PR from a body file")
    c.add_argument("--title", required=True)
    c.add_argument("--body-file", required=True, dest="body_file")
    c.add_argument("--label", action="append", help="repeatable")
    c.add_argument("--base", help="base branch (PR only)")
    c.add_argument("--pr", action="store_true", help="create a PR instead of an issue")
    c.add_argument("--repo", help="OWNER/REPO (defaults to current repo)")

    e = sub.add_parser("edit", help="replace an issue/PR body from a body file")
    e.add_argument("number", help="issue or PR number")
    e.add_argument("--body-file", required=True, dest="body_file")
    e.add_argument("--pr", action="store_true", help="target a PR instead of an issue")
    e.add_argument("--repo", help="OWNER/REPO (defaults to current repo)")

    cm = sub.add_parser("comment", help="add a comment to an issue/PR from a body file")
    cm.add_argument("number", help="issue or PR number")
    cm.add_argument("--body-file", required=True, dest="body_file")
    cm.add_argument("--pr", action="store_true", help="target a PR instead of an issue")
    cm.add_argument("--repo", help="OWNER/REPO (defaults to current repo)")

    rv = sub.add_parser("review", help="post a PR review from a body file")
    rv.add_argument("number", help="PR number")
    rv.add_argument("--body-file", required=True, dest="body_file")
    rv.add_argument("--repo", help="OWNER/REPO (defaults to current repo)")

    rl = sub.add_parser("release", help="create a GitHub release from a notes file")
    rl.add_argument("tag", help="release tag")
    rl.add_argument("--notes-file", required=True, dest="notes_file")
    rl.add_argument("--title")
    rl.add_argument("--repo", help="OWNER/REPO (defaults to current repo)")

    return parser


def main():
    reconfigure_stdio()
    parser = build_parser()
    args, extra = parser.parse_known_args()
    handler = {
        "read": cmd_read,
        "create": cmd_create,
        "edit": cmd_edit,
        "comment": cmd_comment,
        "review": cmd_review,
        "release": cmd_release,
    }[args.cmd]
    sys.exit(handler(args, extra))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
