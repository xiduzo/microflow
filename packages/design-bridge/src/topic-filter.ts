/**
 * Whether `topic` matches the MQTT subscription `filter`: `+` matches exactly
 * one level, and a trailing `#` matches the parent level and everything below it.
 */
export function topicMatches(filter: string, topic: string): boolean {
  const filterLevels = filter.split("/");
  const topicLevels = topic.split("/");
  for (let i = 0; i < filterLevels.length; i++) {
    const level = filterLevels[i];
    if (level === "#") return i === filterLevels.length - 1;
    if (i >= topicLevels.length) return false;
    if (level !== "+" && level !== topicLevels[i]) return false;
  }
  return filterLevels.length === topicLevels.length;
}
