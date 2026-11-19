import { defineHandles, openPorts, type Settings } from "../_base/handle-rule";
import { MAX_HANDLES, type Data } from "./music.schema";

/** The three Ports every Music node has; a record may not shadow them. */
const FIXED_PORTS: readonly string[] = ["play", "stop", "set"];

/** The names of the node's records, in order, each once. */
function recordNames(data: Settings): string[] {
  if (!Array.isArray(data.tracks)) return [];
  const names = new Set<string>();
  for (const track of data.tracks as readonly unknown[]) {
    if (track === null || typeof track !== "object") continue;
    const name = (track as { name?: unknown }).name;
    if (typeof name === "string" && name !== "" && !FIXED_PORTS.includes(name)) names.add(name);
  }
  return [...names];
}

// One open port per record, named after it: wire a trigger to a record to play
// that one. The runtime rejects a record name it does not hold, so a record
// that is removed must not keep its Port. Every record is a Port; the node
// draws the first few.
export const handles = defineHandles<"Music", Data>(
  (data) => ({
    ports: [
      { id: "play", kind: "command", offset: -1 },
      { id: "stop", kind: "command", offset: 0 },
      { id: "set", kind: "value", offset: 1, hint: "name or number" },
      ...openPorts(recordNames(data), "command", MAX_HANDLES),
    ],
    emits: [
      { id: "value", kind: "value", offset: -0.5 },
      { id: "track", kind: "value", offset: 0.5 },
    ],
  }),
  { openPorts: "one input per record, named after `tracks[].name`" },
);
