import { describe, expect, it } from "bun:test";

import {
  CLI_PROVIDERS,
  cliProvider,
  isCliProvider,
  providerLimitation,
  takesSystemFlag,
} from "./cli-providers";
import { providerFamily, providerModel } from "./models";

describe("cli providers", () => {
  it("builds a print-mode argument vector, never a shell string", () => {
    // Verified by hand against the real binaries: `claude -p --model sonnet
    // --append-system-prompt … < prompt` answers. If these flags drift, the
    // subprocess fails at runtime with no compiler to catch it.
    const claude = cliProvider("claude")!;
    expect(claude.args("sonnet", "be terse")).toEqual([
      "-p",
      "--model",
      "sonnet",
      "--append-system-prompt",
      "be terse",
    ]);

    // No model set means the CLI's own default — not an empty `--model` flag,
    // which every one of them rejects.
    expect(cliProvider("opencode")!.args("", null)).toEqual(["run"]);
  });

  it("knows which CLIs take a system prompt out of band", () => {
    // opencode has no such flag, so the adapter folds the system prompt into
    // the message instead. Getting this backwards silently drops it.
    expect(takesSystemFlag(cliProvider("claude")!)).toBe(true);
    expect(takesSystemFlag(cliProvider("opencode")!)).toBe(false);
  });

  it("keeps CLI ids distinguishable from endpoints", () => {
    // `providerFamily` reads the same field for both kinds; a CLI id that
    // looked like a URL would be misfiled as `other`.
    for (const cli of CLI_PROVIDERS) {
      expect(cli.id).not.toContain("/");
      expect(providerFamily(cli.id)).toBe(cli.id);
    }
    expect(providerFamily("https://api.openai.com/v1")).toBe("openai");
  });

  it("never invents an OpenAI model name for a CLI", () => {
    expect(providerModel({ baseUrl: "opencode", model: "" })).toBe("");
    expect(providerModel({ baseUrl: "claude", model: "" })).toBe("sonnet");
    expect(providerModel({ baseUrl: "https://x", model: "" })).toBe("gpt-4o-mini");
  });

  it("drops the opencode session header without eating the answer", () => {
    // Captured from a real `echo … | opencode run`: a blank ANSI reset, the
    // session header, another reset, then the answer.
    const stdout = "\n> build · qwen3-coder:latest\n\nOK\n";
    expect(cliProvider("opencode")!.stripBanner!(stdout).trim()).toBe("OK");

    // An answer that itself starts with a quote must survive when there is no
    // header to strip.
    expect(cliProvider("opencode")!.stripBanner!("plain answer")).toBe("plain answer");
  });

  it("reads a model listing out of each CLI's own format", () => {
    // Captured from `opencode models`: one `provider/model` per line, which is
    // already the form `--model` takes.
    expect(
      cliProvider("opencode")!.listModels!.parse(
        "opencode/big-pickle\nollama/qwen3-coder:latest\n\n",
      ),
    ).toEqual(["opencode/big-pickle", "ollama/qwen3-coder:latest"]);

    // Captured from `pi --list-models` (which prints to stderr): an aligned
    // table with a header row that must not become a model named
    // "provider/model".
    const table = [
      "provider   model                       context  max-out  thinking  images",
      "anthropic  claude-3-5-haiku-latest     200K     8.2K     no        yes   ",
      "openai     gpt-4o-mini                 128K     16K      no        yes   ",
    ].join("\n");
    expect(cliProvider("pi")!.listModels!.parse(table)).toEqual([
      "anthropic/claude-3-5-haiku-latest",
      "openai/gpt-4o-mini",
    ]);
  });

  it("puts the prompt where each CLI actually wants it", () => {
    // Copilot's `-p` takes the prompt as an argument, so its arg vector must
    // end with the flag — the adapter appends the prompt right after it.
    const copilot = cliProvider("copilot")!;
    expect(copilot.promptAsArg).toBe(true);
    expect(copilot.args("auto", null).at(-1)).toBe("-p");

    // Everyone else reads stdin and must not carry a prompt in argv at all.
    for (const cli of CLI_PROVIDERS.filter((entry) => !entry.promptAsArg)) {
      expect(cli.args("m", "sys")).not.toContain("the prompt");
    }
  });

  it("keeps codex out of interactive and git-repo-only modes", () => {
    // `-p` is `--profile` for codex, not print; `exec` is the headless mode and
    // a flow directory is not a git repository.
    const args = cliProvider("codex")!.args("gpt-5", null);
    expect(args[0]).toBe("exec");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).not.toContain("-p");
  });

  it("leaves claude without a listing rather than inventing one", () => {
    // `claude` has no listing subcommand; `KNOWN_MODELS.claude` is the
    // fallback, and `fetchModels` must reach it rather than return nothing.
    expect(cliProvider("claude")!.listModels).toBeUndefined();
  });

  it("says the same thing about a provider on every surface", () => {
    const cli = { kind: "cli", baseUrl: "claude" };
    const http = { kind: "http", baseUrl: "https://api.openai.com/v1" };

    // In a browser a CLI is unusable everywhere, and that outranks any
    // surface-specific objection — one badge, not two.
    for (const surface of ["config", "node", "ask-ai"] as const) {
      expect(providerLimitation(cli, surface, false)?.label).toBe("studio only");
    }

    // On desktop only Ask AI still objects: these CLIs cannot call flow tools.
    expect(providerLimitation(cli, "config", true)).toBeUndefined();
    expect(providerLimitation(cli, "node", true)).toBeUndefined();
    expect(providerLimitation(cli, "ask-ai", true)?.label).toBe("no flow tools");

    // An HTTP provider is never badged — its failures are reachability, which
    // the status dot owns.
    expect(providerLimitation(http, "ask-ai", false)).toBeUndefined();
  });

  it("only treats an explicit cli kind as a CLI", () => {
    // Providers saved before CLIs existed have no `kind` and must stay HTTP.
    expect(isCliProvider({ kind: "cli" })).toBe(true);
    expect(isCliProvider({})).toBe(false);
  });
});
