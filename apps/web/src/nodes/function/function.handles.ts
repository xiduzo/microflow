import { defineHandles, openPorts, textSetting } from "../_base/handle-rule";
import type { Data } from "./function.schema";

/** How many `{{variable}}` Ports fit along the bottom of the node. */
const ROOM = 7;

/** What ends a line, and with it a `//` comment. */
const LINE_END = /[\n\r\u2028\u2029]/g;

/** `[A-Za-z0-9_]`, the characters of a variable name. */
function isWordCharacter(code: number): boolean {
  return (
    (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 95
  );
}

/** `code` without its `//` comments: each runs to the end of its line. */
function withoutLineComments(code: string): string {
  const kept: string[] = [];
  let from = 0;
  for (;;) {
    const start = code.indexOf("//", from);
    if (start === -1) break;
    kept.push(code.slice(from, start));
    LINE_END.lastIndex = start;
    from = LINE_END.exec(code)?.index ?? code.length;
  }
  kept.push(code.slice(from));
  return kept.join("");
}

/** `code` without its block comments. One that is never closed is not a comment. */
function withoutBlockComments(code: string): string {
  const kept: string[] = [];
  let from = 0;
  for (;;) {
    const open = code.indexOf("/*", from);
    if (open === -1) break;
    const close = code.indexOf("*/", open + 2);
    // No later comment can close either.
    if (close === -1) break;
    kept.push(code.slice(from, open));
    from = close + 2;
  }
  kept.push(code.slice(from));
  return kept.join("");
}

/**
 * The `{{variable}}` names a Function's code reads, in order of first use: a
 * run of word characters between `{{` and `}}`. Comments are stripped first
 * (line comments, then block comments), so a variable that is only mentioned
 * in one is not an input.
 *
 * Each step is one pass over the text. This runs for every collaborator on
 * every change of the code, and the code is whatever a peer sends: a
 * backtracking pattern here is a way to stall the room.
 */
export function templateVariables(code: string): string[] {
  const text = withoutBlockComments(withoutLineComments(code));
  const names = new Set<string>();
  let from = 0;
  for (;;) {
    const open = text.indexOf("{{", from);
    if (open === -1) break;
    let end = open + 2;
    while (end < text.length && isWordCharacter(text.charCodeAt(end))) end++;
    if (end > open + 2 && text.startsWith("}}", end)) {
      names.add(text.slice(open + 2, end));
      from = end + 2;
    } else {
      // `{{{name}}` is the variable `name`: try again one brace further on.
      from = open + 1;
    }
  }
  return [...names];
}

// One open port per `{{variable}}`: the runtime stores whatever arrives on a
// Port it does not know under that name, for the code to read. Every variable
// is a Port; the node draws the first few.
export const handles = defineHandles<"Function", Data>(
  (data) => ({
    ports: [
      { id: "trigger", kind: "command" },
      ...openPorts(
        templateVariables(textSetting(data, "code")).filter((name) => name !== "trigger"),
        "value",
        ROOM,
      ),
    ],
    emits: [{ id: "value", kind: "value" }],
  }),
  { openPorts: "one input per {{name}} in `code`" },
);
