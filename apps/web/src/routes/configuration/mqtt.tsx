// Reachable in both hosts: since ADR-0009 the browser runs the Mqtt/Figma nodes
// itself (MQTT over WebSocket), and it reads the broker list straight from this
// store — so a web user who cannot open this page cannot use those nodes at all.
//
// The page is a console: the broker list is a rail, and the transcript below it
// is a real client — the desktop host's native `MqttManager` over IPC, or the
// browser's own mqtt.js connection. What you can do here is what a flow can do.
import { createFileRoute } from "@tanstack/react-router";
import { AntennaIcon, PlusIcon, RadioIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  useMqttBrokerStore,
  type ConnectionStatus,
  type MqttBrokerConfig,
} from "@/stores/mqtt-broker";
import { track } from "@/lib/analytics";
import { invokeCommand, useListen, type MqttMessagePayload } from "@/lib/ipc";
import { isDesktop } from "@/lib/platform";
import { openTestClient, type TestClient } from "@/session/browser-mqtt-test-client";
import { isBrowserReachableBroker } from "@/components/flow/nodes/_base/browser-support";
import {
  ConnectionConsole,
  ConsoleChip,
  ConsoleField,
  appendLine,
  type ConnectionStatusTone,
  type ConsoleCommand,
  type ConsoleLine,
} from "@/components/config/connection-console";
import { parseCommand, restAfter } from "@/components/config/parse-command";
import { EmptyState } from "@/components/states/empty-state";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/configuration/mqtt")({
  component: MqttConfigPage,
});

/** Long verbs read better in a transcript; the short forms still work. */
const COMMANDS: ConsoleCommand[] = [
  {
    name: "subscribe",
    args: "<topic>",
    help: "Listen to a topic. Wildcards: + and #",
    insert: "subscribe ",
    aliases: ["sub"],
  },
  {
    name: "unsubscribe",
    args: "<topic>",
    help: "Stop listening to a topic",
    insert: "unsubscribe ",
    aliases: ["unsub"],
  },
  {
    name: "publish",
    args: "<topic> <payload>",
    help: "Send a message to a topic",
    insert: "publish ",
    aliases: ["pub"],
  },
  { name: "clear", help: "Empty the transcript", insert: "clear" },
  { name: "?", help: "List every command", insert: "?" },
];

function statusTone(status: ConnectionStatus | undefined): ConnectionStatusTone {
  if (status === "connected") return "ok";
  if (status === "connecting") return "busy";
  if (status === "error") return "error";
  return "idle";
}

/**
 * The console's transport, one per host. Desktop drives the native `MqttManager`
 * over IPC and gets inbound messages as "mqtt-message" events; the browser opens
 * its own mqtt.js connection for as long as the page is mounted (see
 * `openTestClient`) and feeds `onMessage` directly. Same three operations either
 * way, so the page below has no platform branches.
 */
function useBrokerTransport(
  broker: MqttBrokerConfig | undefined,
  onMessage: (topic: string, payload: string) => void,
) {
  const client = useRef<TestClient | null>(null);
  const setStatus = useMqttBrokerStore((state) => state.setStatus);
  // The page passes a fresh closure every render; keep the latest without
  // tearing down the connection (same trick as `useListen`).
  const messageHandler = useRef(onMessage);
  messageHandler.current = onMessage;

  const brokerId = broker?.id ?? "";
  const url = broker?.url ?? "";

  useEffect(() => {
    if (isDesktop() || !broker || url.trim() === "") return;
    const opened = openTestClient(
      broker,
      (topic, payload) => messageHandler.current(topic, payload),
      (status) => setStatus(broker.id, status),
    );
    client.current = opened;
    return () => {
      opened.end();
      client.current = null;
    };
    // Reconnect when the broker or its URL changes, not on every keystroke in
    // an unrelated field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brokerId, url, setStatus]);

  // Desktop delivers inbound messages as a host event rather than a callback.
  useListen<MqttMessagePayload>({
    type: "mqtt-message",
    handler: (event) => messageHandler.current(event.payload.topic, event.payload.payload),
  });

  return {
    subscribe: async (topic: string) =>
      isDesktop()
        ? await invokeCommand({ type: "mqtt_subscribe", brokerId, topic })
        : { success: (await client.current?.subscribe(topic)) ?? false },
    unsubscribe: async (topic: string) =>
      isDesktop()
        ? await invokeCommand({ type: "mqtt_unsubscribe", brokerId, topic })
        : { success: (await client.current?.unsubscribe(topic)) ?? false },
    publish: async (topic: string, payload: string) =>
      isDesktop()
        ? await invokeCommand({ type: "mqtt_publish", brokerId, topic, payload })
        : { success: client.current?.publish(topic, payload) ?? false },
  };
}

function MqttConfigPage() {
  const brokers = useMqttBrokerStore((state) => state.brokers);
  const statuses = useMqttBrokerStore((state) => state.statuses);
  const addBroker = useMqttBrokerStore((state) => state.addBroker);
  const updateBroker = useMqttBrokerStore((state) => state.updateBroker);
  const deleteBroker = useMqttBrokerStore((state) => state.deleteBroker);
  const setDefaultBroker = useMqttBrokerStore((state) => state.setDefaultBroker);

  const [selectedId, setSelectedId] = useState(
    () => brokers.find((broker) => broker.isDefault)?.id ?? brokers[0]?.id ?? "",
  );
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [subscriptions, setSubscriptions] = useState<string[]>([]);

  const broker = brokers.find((entry) => entry.id === selectedId);
  const push = (line: Omit<ConsoleLine, "at">) => setLines((previous) => appendLine(previous, line));

  const transport = useBrokerTransport(broker, (topic, payload) =>
    push({ kind: "in", label: topic, text: payload }),
  );

  // A broker is added blank and configured in place, so the "added" event fires
  // once its URL exists — otherwise every entry would report an empty scheme.
  const tracked = useRef(new Set<string>());
  const trackConfigured = (entry: MqttBrokerConfig) => {
    if (entry.url.trim() === "" || tracked.current.has(entry.id)) return;
    tracked.current.add(entry.id);
    track("mqtt_broker_added", {
      scheme: entry.url.split("://")[0] || "unknown",
      auth: Boolean(entry.username),
    });
  };

  const select = (id: string) => {
    setSelectedId(id);
    setLines([]);
    setSubscriptions([]);
  };

  const subscribe = async (topic: string) => {
    const { success } = await transport.subscribe(topic);
    if (success) setSubscriptions((previous) => [...new Set([...previous, topic])]);
    push({
      kind: success ? "sys" : "err",
      label: topic,
      text: success ? "subscribed" : "could not subscribe — is the broker connected?",
    });
  };

  const unsubscribe = async (topic: string) => {
    const { success } = await transport.unsubscribe(topic);
    if (success) setSubscriptions((previous) => previous.filter((entry) => entry !== topic));
    push({ kind: success ? "sys" : "err", label: topic, text: success ? "unsubscribed" : "could not unsubscribe" });
  };

  const run = async (input: string) => {
    const parsed = parseCommand(input);
    const topic = parsed.tokens[0];

    switch (parsed.verb) {
      case "subscribe":
      case "sub":
        if (!topic) return push({ kind: "err", text: "subscribe needs a topic — try: subscribe test/#" });
        return subscribe(topic);
      case "unsubscribe":
      case "unsub":
        if (!topic) return push({ kind: "err", text: "unsubscribe needs a topic" });
        return unsubscribe(topic);
      case "publish":
      case "pub": {
        if (!topic) {
          return push({ kind: "err", text: "publish needs a topic — try: publish test/hello world" });
        }
        const payload = restAfter(parsed, 1);
        const { success } = await transport.publish(topic, payload);
        return push({
          kind: success ? "out" : "err",
          label: topic,
          text: success ? payload : "could not publish — is the broker connected?",
        });
      }
      case "clear":
        return setLines([]);
      case "?":
      case "help":
        return push({ kind: "sys", text: "", table: commands });
      default:
        return push({ kind: "err", text: `unknown command "${parsed.verb}" — press ? for the list` });
    }
  };

  // Topics the console has actually touched, newest first — better completions
  // than any list we could guess at.
  const knownTopics = useMemo(() => {
    const seen = lines.map((line) => line.label).filter((label): label is string => Boolean(label));
    return [...new Set([...subscriptions, ...seen.reverse()])];
  }, [lines, subscriptions]);

  const commands = useMemo<ConsoleCommand[]>(
    () =>
      COMMANDS.map((command) => {
        if (command.name === "unsubscribe") return { ...command, values: () => subscriptions };
        if (command.name === "subscribe" || command.name === "publish") {
          return { ...command, values: () => knownTopics };
        }
        return command;
      }),
    [knownTopics, subscriptions],
  );

  const browserUnreachable =
    !isDesktop() && Boolean(broker) && broker!.url.trim() !== "" && !isBrowserReachableBroker(broker!.url);

  return (
    <ConnectionConsole
      title="mqtt"
      connections={brokers.map((entry) => ({
        id: entry.id,
        name: entry.name,
        subtitle: entry.url,
        isDefault: entry.isDefault,
        status: statusTone(statuses[entry.id]),
      }))}
      selectedId={selectedId}
      onSelect={select}
      addLabel="broker"
      onAdd={() =>
        select(addBroker({ name: "New broker", url: "", isDefault: brokers.length === 0 }))
      }
      lines={lines}
      onClear={() => setLines([])}
      commands={commands}
      onRun={run}
      placeholder="subscribe test/#"
      emptyState={
        brokers.length === 0 ? (
          <EmptyState
            icon={RadioIcon}
            title="No brokers yet"
            description="Add a broker to publish and subscribe from here — and from your flows."
          >
            <Button
              size="sm"
              onClick={() =>
                select(addBroker({ name: "New broker", url: "", isDefault: true }))
              }
            >
              <PlusIcon /> Add broker
            </Button>
          </EmptyState>
        ) : (
          <EmptyState
            icon={AntennaIcon}
            title="Nothing has come through yet"
            description="Subscribe to a topic and anything published to it shows up here."
          >
            <code className="text-[11px] text-muted-foreground">
              subscribe test/# · publish test/hello world
            </code>
          </EmptyState>
        )
      }
      chips={
        subscriptions.length > 0 ? (
          <>
            <span className="text-[11px] text-muted-foreground self-center">listening:</span>
            {subscriptions.map((topic) => (
              <ConsoleChip key={topic} onRemove={() => unsubscribe(topic)} removeLabel={`Unsubscribe from ${topic}`}>
                {topic}
              </ConsoleChip>
            ))}
          </>
        ) : null
      }
      detail={
        broker && (
          <>
            <ConsoleField
              label="Name"
              value={broker.name}
              onChange={(event) => updateBroker(broker.id, { name: event.target.value })}
            />
            <ConsoleField
              label="URL"
              value={broker.url}
              placeholder="wss://broker.example.com:8883/mqtt"
              tone={browserUnreachable ? "warning" : undefined}
              hint={
                browserUnreachable
                  ? "A browser can only reach a broker over ws:// or wss://. This URL works in the desktop app, but not on the web."
                  : "ws:// or wss:// in the browser; any scheme in the desktop app."
              }
              onChange={(event) => updateBroker(broker.id, { url: event.target.value })}
              onBlur={() => trackConfigured(broker)}
            />
            <ConsoleField
              label="Username"
              value={broker.username ?? ""}
              placeholder="optional"
              onChange={(event) => updateBroker(broker.id, { username: event.target.value })}
            />
            <ConsoleField
              label="Password"
              type="password"
              value={broker.password ?? ""}
              placeholder="optional"
              onChange={(event) => updateBroker(broker.id, { password: event.target.value })}
            />
            <div className="flex items-center gap-3 pt-1 text-[11px]">
              {broker.isDefault ? (
                <span className="text-accent">default broker</span>
              ) : (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setDefaultBroker(broker.id)}
                >
                  make default
                </button>
              )}
              <button
                type="button"
                className="ml-auto text-muted-foreground hover:text-destructive"
                onClick={() => {
                  deleteBroker(broker.id);
                  select(brokers.find((entry) => entry.id !== broker.id)?.id ?? "");
                }}
              >
                delete
              </button>
            </div>
          </>
        )
      }
    />
  );
}
