// MQTT topic-filter matching: which messages a subscription receives.
//
// A broker decides this for what it sends. A client that holds several
// subscriptions on one connection decides it again for what arrives, because a
// message does not say which of them it is for. Both browser clients do: the
// flow's broker sessions (`mqtt-client.ts`) and the Connection Console
// (`connection-console/broker-console-session.ts`). The desktop's
// `MqttBroker::topic_matches` is held to the same case table
// (`fixtures/topic-filter.json`).

/** A shared subscription: `$share/<group>/<filter>`, or the older `$queue/<filter>`. */
const SHARE = "$share/";
const QUEUE = "$queue/";

const hasWildcard = (text: string): boolean => text.includes("+") || text.includes("#");

/**
 * Whether `topic` can be published on: at least one character, no wildcard
 * and no NUL (MQTT 3.1.1 §4.7.3, §1.5.3). A broker closes the connection of a
 * client that publishes on any other.
 */
export function isTopicName(topic: string): boolean {
  return topic.length > 0 && !hasWildcard(topic) && !topic.includes("\u0000");
}

/** The filter a subscription to `filter` matches topics with: `filter` without
 *  its shared-subscription prefix, or `undefined` when it is not a valid filter
 *  (§4.7.1, MQTT 5 §4.8.2). */
function matchingFilter(filter: string): string[] | undefined {
  let plain = filter;
  if (filter.startsWith(SHARE)) {
    const rest = filter.slice(SHARE.length);
    const end = rest.indexOf("/");
    if (end <= 0 || hasWildcard(rest.slice(0, end))) return undefined;
    plain = rest.slice(end + 1);
  } else if (filter.startsWith(QUEUE)) {
    plain = filter.slice(QUEUE.length);
  }
  if (plain.length === 0 || plain.includes("\u0000")) return undefined;
  const levels = plain.split("/");
  const valid = levels.every(
    (level, index) =>
      !hasWildcard(level) || level === "+" || (level === "#" && index === levels.length - 1),
  );
  return valid ? levels : undefined;
}

/**
 * Whether a subscription to `filter` delivers messages on `topic`.
 *
 * - `+` fills a whole level and matches exactly one level.
 * - `#` is the last level, alone, and matches the parent level and everything
 *   below it.
 * - A topic that starts with `$` (`$SYS/…`) is not matched by a filter that
 *   starts with a wildcard: a broker does not send those for `#` or `+/…`.
 * - A shared subscription names its group in front of the filter, and the
 *   broker delivers on the plain topic, so the group is not part of the match.
 * - An invalid filter, or a topic that is not a topic name ({@link isTopicName}),
 *   matches nothing: a broker refuses the one and never delivers on the other.
 */
export function topicMatches(filter: string, topic: string): boolean {
  const filterLevels = matchingFilter(filter);
  if (filterLevels === undefined || !isTopicName(topic)) return false;
  const topicLevels = topic.split("/");
  if (topic.startsWith("$") && (filterLevels[0] === "#" || filterLevels[0] === "+")) return false;
  for (let index = 0; index < filterLevels.length; index++) {
    const level = filterLevels[index];
    if (level === "#") return true;
    if (index >= topicLevels.length) return false;
    if (level !== "+" && level !== topicLevels[index]) return false;
  }
  return filterLevels.length === topicLevels.length;
}
