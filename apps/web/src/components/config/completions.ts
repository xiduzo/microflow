/**
 * Console completion: what to offer while the user is mid-command.
 *
 * Two phases, the same as any editor's — the first word completes to a command
 * name, and after that the command's own values complete its first argument
 * (topics it has seen, models it knows). Kept pure and away from the component
 * so the rules are readable and testable on their own.
 */
export type ConsoleCommand = {
  /** The first word the user types. */
  name: string;
  /** Shown after the name in the hint chip and as ghost text, e.g. "<topic>". */
  args?: string;
  help: string;
  /** Put into the input when the hint chip is clicked. Defaults to "<name> ". */
  insert?: string;
  /** Short forms that also run this command; never offered as completions. */
  aliases?: string[];
  /** Completions for the first argument — known topics, known models. */
  values?: () => string[];
};

export type Suggestion = { value: string; args?: string; detail?: string };

export type Completion = {
  suggestions: Suggestion[];
  /** The text a suggestion replaces — the ghost is the rest of it. */
  prefix: string;
  /** Argument signature to show once the command name is complete. */
  signature: string;
};

const MAX_VALUE_SUGGESTIONS = 8;

export function completeCommand(commands: ConsoleCommand[], input: string): Completion {
  const empty: Completion = { suggestions: [], prefix: "", signature: "" };
  if (input === "") return empty;

  const verb = input.trimStart().split(/\s+/, 1)[0].toLowerCase();
  const onFirstWord = !/\s/.test(input.trim()) && !input.endsWith(" ");

  if (onFirstWord) {
    // Substring, not just prefix: typing "sub" should still find "unsubscribe".
    // Commands that start with what was typed come first.
    const matches = commands.filter(
      (command) => command.name.includes(verb) && command.name !== verb,
    );
    return {
      prefix: verb,
      signature: "",
      suggestions: matches
        .sort(
          (left, right) =>
            Number(right.name.startsWith(verb)) - Number(left.name.startsWith(verb)),
        )
        .map((command) => ({ value: command.name, args: command.args, detail: command.help })),
    };
  }

  const matched = commands.find(
    (command) => command.name === verb || command.aliases?.includes(verb),
  );
  if (!matched) return empty;

  // Only the first argument is completed; past that it is free text (a payload,
  // a prompt) that no list can usefully predict.
  const argumentPrefix = input.endsWith(" ") ? "" : (input.split(/\s+/).at(-1) ?? "");
  const wordCount = input.trim().split(/\s+/).length;
  const onFirstArgument = input.endsWith(" ") ? wordCount === 1 : wordCount === 2;
  const signature = argumentPrefix === "" && wordCount === 1 ? (matched.args ?? "") : "";

  if (!matched.values || !onFirstArgument) return { suggestions: [], prefix: argumentPrefix, signature };

  return {
    prefix: argumentPrefix,
    signature,
    suggestions: matched
      .values()
      .filter((value) => value.startsWith(argumentPrefix) && value !== argumentPrefix)
      .slice(0, MAX_VALUE_SUGGESTIONS)
      .map((value) => ({ value })),
  };
}

/** The input after accepting a suggestion, with a trailing space to type on. */
export function applyCompletion(input: string, prefix: string, value: string): string {
  return `${input.slice(0, input.length - prefix.length)}${value} `;
}

/* ── syntax highlighting ────────────────────────────────────────────────── */

export type CommandTokenKind = "command" | "unknown" | "arg" | "text" | "space";
export type CommandToken = { text: string; kind: CommandTokenKind };

/**
 * A placeholder standing for free-form text rather than a structured value: the
 * payload of a message, the prompt of a question. Everything else — a topic, a
 * model name — is an argument, and is coloured as one.
 */
const FREE_TEXT_PLACEHOLDER = /^<(payload|prompt|text|message)>$/;

/**
 * Split an input line into coloured tokens: `publish some/topic hello there`
 * reads as command · arg · text.
 *
 * Whitespace is preserved as its own token so a rendered overlay lines up with
 * the input it sits on, character for character.
 */
export function tokenizeCommand(commands: ConsoleCommand[], input: string): CommandToken[] {
  let wordIndex = 0;
  let placeholders: string[] = [];

  return input
    .split(/(\s+)/)
    .filter((part) => part !== "")
    .map((part) => {
      if (/^\s+$/.test(part)) return { text: part, kind: "space" as const };

      if (wordIndex++ === 0) {
        const verb = part.toLowerCase();
        const matched = commands.find(
          (command) => command.name === verb || command.aliases?.includes(verb),
        );
        placeholders = matched?.args?.split(/\s+/) ?? [];
        return { text: part, kind: matched ? ("command" as const) : ("unknown" as const) };
      }

      // Past the declared placeholders the last one repeats — a payload keeps
      // being a payload however many words long it is.
      const placeholder = placeholders[wordIndex - 2] ?? placeholders.at(-1);
      const free = !placeholder || FREE_TEXT_PLACEHOLDER.test(placeholder);
      return { text: part, kind: free ? ("text" as const) : ("arg" as const) };
    });
}

/** The same colouring for a command's argument signature, e.g. in a hint chip. */
export function tokenizeArgs(command: ConsoleCommand): CommandToken[] {
  if (!command.args) return [];
  return command.args.split(/(\s+)/).map((part) => ({
    text: part,
    kind: /^\s+$/.test(part)
      ? ("space" as const)
      : FREE_TEXT_PLACEHOLDER.test(part)
        ? ("text" as const)
        : ("arg" as const),
  }));
}
