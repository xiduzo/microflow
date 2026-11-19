import { defineHandles, openPorts, textSetting } from "../_base/handle-rule";
import type { Data } from "./llm.schema";

/** How many `{{variable}}` Ports fit along the bottom of the node. */
const ROOM = 7;

/** What ends a line. A `{{variable}}` does not span one. */
const LINE_END = /[\n\r\u2028\u2029]/g;

/**
 * The `{{variable}}` names a prompt reads, in order of first use: whatever
 * stands between a `{{` and the next `}}` on the same line, spaces included.
 * The runtime substitutes `{{` + name + `}}` literally, so the name is taken as
 * written.
 *
 * One pass over the text. This runs for every collaborator on every change of
 * the prompt, and a prompt is whatever a peer sends: a backtracking pattern
 * here is a way to stall the room.
 */
function templateVariables(prompt: string): string[] {
  const names = new Set<string>();
  let from = 0;
  // The next `}}` and the next line end, looked up again only once passed.
  let close = -1;
  let lineEnd = -1;
  for (;;) {
    const open = prompt.indexOf("{{", from);
    if (open === -1) break;
    const inner = open + 2;
    if (close < inner) {
      close = prompt.indexOf("}}", inner);
      if (close === -1) break;
    }
    if (lineEnd < inner) {
      LINE_END.lastIndex = inner;
      lineEnd = LINE_END.exec(prompt)?.index ?? prompt.length;
    }
    if (lineEnd < close) {
      // Nothing closes on this line: no variable starts on what is left of it.
      from = lineEnd + 1;
      continue;
    }
    const name = prompt.slice(inner, close);
    if (name !== "") names.add(name);
    from = close + 2;
  }
  return [...names];
}

// One open port per `{{variable}}` in the prompt: the runtime keeps whatever
// arrives on a Port it does not know under that name and substitutes it into
// the prompt. Every variable is a Port; the node draws the first few.
export const handles = defineHandles<"Llm", Data>(
  (data) => ({
    ports: [
      { id: "trigger", kind: "command" },
      ...openPorts(
        templateVariables(textSetting(data, "prompt")).filter((name) => name !== "trigger"),
        "value",
        ROOM,
      ),
    ],
    emits: [
      { id: "thinking", kind: "state", offset: -1.5, hint: "true while generating" },
      { id: "done", kind: "event", offset: -0.5, hint: "fires on completion" },
      { id: "value", kind: "value", offset: 0.5 },
      { id: "error", kind: "event", offset: 1.5, hint: "fires with the reason when it fails" },
    ],
  }),
  { openPorts: "one input per {{name}} in `prompt`" },
);
