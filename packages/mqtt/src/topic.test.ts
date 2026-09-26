import { expect, test } from "bun:test";
import { topicMatches } from "./topic";

test.each([
  ["microflow/uid/+/status", "microflow/uid/figma/status", true],
  ["microflow/uid/+/status", "microflow/uid/figma/x/status", false],
  ["microflow/uid/+/variable/+/set", "microflow/uid/app/variable/1-2/set", true],
  ["microflow/uid/+/variable/+/set", "microflow/uid/app/variable/1-2", false],
  ["microflow/uid/app/variable/1-2", "microflow/uid/app/variable/1-2/set", false],
  ["microflow/uid/app/variable/1-2", "microflow/uid/app/variable/1-20", false],
  ["microflow/uid/app/variable/1-2", "prefix/microflow/uid/app/variable/1-2", false],
  ["microflow/#", "microflow", true],
  ["microflow/#", "microflow/uid/a/b", true],
  ["#", "anything/at/all", true],
  ["microflow/uid/figma/variables", "microflow/uid/figma/variables", true],
] as const)("%s ~ %s → %p", (filter, topic, expected) => {
  expect(topicMatches(filter, topic)).toBe(expected);
});
