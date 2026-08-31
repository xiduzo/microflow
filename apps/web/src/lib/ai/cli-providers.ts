// Local agent CLIs as LLM providers.
//
// Claude Code, opencode and pi are already on the user's machine and already
// hold that user's model credentials — no key to paste, no endpoint to reach.
// What they are not is HTTP: none speaks the OpenAI chat-completions protocol
// the rest of the transport is built on (ADR-0021) and none runs a server, so
// reaching one means running the binary. That is a subprocess, so these
// providers exist on desktop only; `browser-support` style gating is the
// `isDesktop()` check at every entry point below.
//
// All three converge on the same shape — a print flag, a model flag, the prompt
// on stdin — which is the whole reason one table serves them.
//
// This mirrors the `ALLOWED` list in `src-tauri/src/cli_llm.rs`. Adding a CLI
// means adding it in both places, deliberately: the Rust side is what decides
// which binaries this app may ever execute, and it will not take our word for it.

/** How to ask one CLI for a single non-interactive answer. */
export type CliProvider = {
  /** Stored as a provider's `baseUrl`. Also the binary name. */
  id: string;
  title: string;
  blurb: string;
  /** A model the CLI accepts, used as the default when a provider is added. */
  defaultModel: string;
  /** Argument vector for one print-mode run, prompt excluded. */
  args: (model: string, system: string | null) => string[];
  /** Set when the CLI takes its prompt as an argument rather than on stdin, in
   *  which case the prompt is appended to {@link args} — so those args must end
   *  with the flag it belongs to. Copilot is the only one; everything else
   *  reads stdin, which has no length limit to run into. */
  promptAsArg?: true;
  /** Drop whatever chrome this CLI prints around the answer. Runs after ANSI
   *  codes are stripped, so it can match on plain text. */
  stripBanner?: (stdout: string) => string;
  /** How to ask this CLI which models it can reach, and how to read the reply.
   *  Omitted when it has no listing at all — `KNOWN_MODELS` covers those. */
  listModels?: { args: string[]; parse: (output: string) => string[] };
};

export const CLI_PROVIDERS: CliProvider[] = [
  {
    id: "claude",
    title: "Claude Code",
    blurb: "The claude CLI on this machine. No key — it uses your login.",
    defaultModel: "sonnet",
    // No listing subcommand exists, so the aliases in `KNOWN_MODELS.claude` are
    // the whole catalogue — which is fine, because aliases are what Claude Code
    // wants anyway ("sonnet" resolves to the current one).
    args: (model, system) => [
      "-p",
      ...(model ? ["--model", model] : []),
      // Appends rather than replaces: Claude Code's own prompt is what makes it
      // competent, and there is no flag to drop it.
      ...(system ? ["--append-system-prompt", system] : []),
    ],
  },
  {
    id: "codex",
    title: "Codex",
    blurb: "The codex CLI on this machine, signed in to your OpenAI account.",
    defaultModel: "",
    // `-p` here is `--profile`, not print — `exec` is the non-interactive mode.
    // `--skip-git-repo-check` because a flow is not a repository and codex
    // refuses to run outside one by default; `--color never` keeps escape codes
    // out of the answer. No system-prompt flag exists, so it is folded in.
    args: (model) => [
      "exec",
      "--skip-git-repo-check",
      "--color",
      "never",
      ...(model ? ["--model", model] : []),
    ],
  },
  {
    id: "opencode",
    title: "opencode",
    blurb: "The opencode CLI on this machine, with the providers you set up there.",
    // opencode wants `provider/model`; leaving it empty uses its own default,
    // which is the sane thing for a user who already configured opencode.
    defaultModel: "",
    // No system-prompt flag exists, so a system prompt is prepended to the
    // prompt itself in `cli-adapter.ts` instead.
    args: (model) => ["run", ...(model ? ["--model", model] : [])],
    // `opencode run` opens with a session header — `> <agent> · <model>` — and
    // only then the answer. `--format json` would avoid it but replaces the
    // answer with a raw event stream we would have to reassemble, which is a
    // worse trade for one line.
    stripBanner: (stdout) => {
      const header = /^>.*$/m.exec(stdout);
      return header ? stdout.slice(header.index + header[0].length) : stdout;
    },
    // One `provider/model` per line, which is exactly the form `--model` takes.
    listModels: {
      args: ["models"],
      parse: (output) =>
        output
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.includes("/") && !line.includes(" ")),
    },
  },
  {
    id: "gemini",
    title: "Gemini CLI",
    blurb: "The gemini CLI on this machine, with the Google account you signed in there.",
    defaultModel: "",
    // `-p ""` is what puts it in headless mode; the help is explicit that a
    // prompt given this way is *appended to stdin*, so an empty one leaves the
    // piped prompt as the whole input. `-o text` keeps it from answering JSON.
    args: (model) => ["-p", "", "-o", "text", ...(model ? ["--model", model] : [])],
  },
  {
    id: "copilot",
    title: "GitHub Copilot",
    blurb: "The copilot CLI on this machine, signed in to your GitHub account.",
    defaultModel: "auto",
    // The one CLI here that will not read a prompt from stdin: `-p` takes it as
    // an argument, so it goes last (see `promptAsArg`). `--allow-all-tools` is
    // required for non-interactive mode — without it the run blocks on a
    // permission prompt no one can answer.
    promptAsArg: true,
    args: (model) => [
      "--no-color",
      "--allow-all-tools",
      ...(model ? ["--model", model] : []),
      "-p",
    ],
  },
  {
    id: "pi",
    title: "pi",
    blurb: "The pi CLI on this machine, with the provider you set up there.",
    defaultModel: "",
    args: (model, system) => [
      "-p",
      ...(model ? ["--model", model] : []),
      ...(system ? ["--append-system-prompt", system] : []),
    ],
    // A whitespace-aligned table on stderr: `provider  model  context  …`, with
    // a header row. `--model` accepts `provider/id`, so the first two columns
    // are what we want and the rest is display.
    listModels: {
      args: ["--list-models"],
      parse: (output) =>
        output
          .split("\n")
          .map((line) => line.trim().split(/\s+/))
          .filter(([provider, model]) => provider && model && provider !== "provider")
          .map(([provider, model]) => `${provider}/${model}`),
    },
  },
];

/**
 * Whether a provider configuration is answered by a local CLI.
 *
 * The one predicate for it, because the answer changes several unrelated
 * things: the config page hides endpoint and key fields, the probe looks for a
 * binary instead of a URL, and — the one that would otherwise fail silently —
 * `hostLimitation` (`browser-support.ts`) rules it out of Ask AI. These CLIs
 * run their own tools and have no wire format for ours, so an Ask AI turn
 * against one comes back as prose where the panel expected `add_node`, and
 * every write the user asked for is quietly dropped.
 */
export function isCliProvider(provider: { kind?: string }): boolean {
  return provider.kind === "cli";
}

/** The CLI a provider config points at, if it is a CLI provider at all. */
export function cliProvider(id: string): CliProvider | undefined {
  return CLI_PROVIDERS.find((entry) => entry.id === id);
}

/** Whether this CLI can be told a system prompt out of band. When it cannot,
 *  the adapter folds the system prompt into the message it sends. */
export function takesSystemFlag(cli: CliProvider): boolean {
  return cli.args("m", "s").includes("s");
}
