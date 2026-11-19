import { describe, expect, test } from "bun:test";
import table from "./fixtures/topic-filter.json";
import { isTopicName, topicMatches } from "./topic-filter";

// The case table both hosts route by; the desktop runs the same one
// (`src-tauri/tests/mqtt_routing.rs`).
for (const group of table.groups) {
  describe(group.rule, () => {
    test.each(group.cases as Array<[string, string, boolean]>)("%s ~ %s → %p", (filter, topic, matches) => {
      expect(topicMatches(filter, topic)).toBe(matches);
    });
  });
}

describe("isTopicName", () => {
  test("a topic name is not empty and holds no wildcard and no NUL", () => {
    const names = ["a", "a/b", "/", "$SYS/x", "a b", "", "a/+", "a/#", "+", "#", "a\u0000b"];
    expect(names.filter(isTopicName)).toEqual(["a", "a/b", "/", "$SYS/x", "a b"]);
  });
});
