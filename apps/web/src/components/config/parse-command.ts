/**
 * The console command grammar shared by the MQTT and LLM configuration pages:
 * a verb, whitespace-separated tokens, and the raw remainder.
 *
 * The remainder matters — an MQTT payload and an LLM prompt are free text and
 * must survive verbatim, so they are sliced off the original string rather than
 * rebuilt from the tokens.
 */
export type ParsedCommand = {
  /** First word, lowercased. Empty string when the input was blank. */
  verb: string;
  /** Whitespace-separated words after the verb. */
  tokens: string[];
  /** Everything after the verb, unaltered apart from surrounding whitespace. */
  rest: string;
};

export function parseCommand(input: string): ParsedCommand {
  const raw = input.trim();
  if (raw === "") return { verb: "", tokens: [], rest: "" };

  const verb = raw.split(/\s+/, 1)[0];
  const rest = raw.slice(verb.length).trim();
  return {
    verb: verb.toLowerCase(),
    tokens: rest === "" ? [] : rest.split(/\s+/),
    rest,
  };
}

/**
 * The remainder after the first `count` tokens — `pub some/topic hello  world`
 * keeps its double space in the payload.
 */
export function restAfter(parsed: ParsedCommand, count: number): string {
  let rest = parsed.rest;
  for (const token of parsed.tokens.slice(0, count)) {
    rest = rest.slice(rest.indexOf(token) + token.length);
  }
  return rest.trim();
}
