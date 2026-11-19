import { describe, expect, test } from "bun:test";
import table from "../fixtures/topic-filter.json";
import { topicMatches } from "./topic-filter";

// The one case table every MQTT client in microflow routes by: the plugins'
// brokers here, Studio's browser host (`apps/web/src/cloud/topic-filter.ts`)
// and the desktop host (`src-tauri/tests/mqtt_routing.rs`).
for (const group of table.groups) {
  describe(group.rule, () => {
    test.each(group.cases as Array<[string, string, boolean]>)("%s ~ %s → %p", (filter, topic, matches) => {
      expect(topicMatches(filter, topic)).toBe(matches);
    });
  });
}

// The bridge's own topic shapes (ADR-0028), on top of the table.
describe("bridge topics", () => {
  test.each([
    ["microflow/uid/+/status", "microflow/uid/figma/status", true],
    ["microflow/uid/+/status", "microflow/uid/figma/x/status", false],
    ["microflow/uid/+/variable/+/set", "microflow/uid/app/variable/1-2/set", true],
    ["microflow/uid/+/variable/+/set", "microflow/uid/app/variable/1-2", false],
    ["microflow/uid/app/variable/1-2", "microflow/uid/app/variable/1-2/set", false],
    ["microflow/uid/app/variable/1-2", "microflow/uid/app/variable/1-20", false],
    ["microflow/uid/figma/variables", "microflow/uid/figma/variables", true],
  ] as const)("%s ~ %s → %p", (filter, topic, expected) => {
    expect(topicMatches(filter, topic)).toBe(expected);
  });
});
