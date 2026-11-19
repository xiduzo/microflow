// MQTT topic-filter matching: which messages a subscription receives.
//
// One matcher for every MQTT client in microflow, held to one case table
// (`@microflow/design-bridge/fixtures/topic-filter.json`): it lives in
// `@microflow/design-bridge` with the plugins' brokers, and both browser
// clients route by it here: the flow's broker sessions (`mqtt-client.ts`) and
// the Connection Console (`connection-console/broker-console-session.ts`).
export { isTopicName, topicMatches } from "@microflow/design-bridge";
