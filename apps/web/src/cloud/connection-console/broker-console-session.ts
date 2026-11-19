/**
 * The Connection Console session for MQTT brokers: what `subscribe`,
 * `unsubscribe` and `publish` do, which inbound messages reach the transcript,
 * and what the console holds on a broker while it is selected.
 *
 * The console is a real client, so the session talks to the broker through a
 * transport seam with one adapter per host (`broker-transport.ts`): the desktop
 * host's native `MqttManager` over IPC, or the browser's own mqtt.js
 * connection. Brokers themselves are read from `useMqttBrokerStore`, as their
 * settings have settled: the link does not follow a URL while it is typed.
 */
import {
  brokerSettingsForm,
  settleBrokerSettings,
  useMqttBrokerStore,
  type MqttBrokerConfig,
} from "@/cloud/mqtt-broker";
import { topicMatches } from "@/cloud/topic-filter";
import { track as trackEvent } from "@/lib/analytics";

import type { ConsoleCommand } from "./completions";
import {
  createTranscript,
  restAfter,
  type ConsoleSession,
  type Reply,
} from "./console-session";

/* ── the transport seam ─────────────────────────────────────────────────── */

/** One message the host received, and the broker it says it came from. */
export type BrokerMessage = { brokerId: string; topic: string; payload: string };

/**
 * A console's hold on one broker. Every operation resolves `false` when the
 * broker refused it or is not connected, and never rejects. `unsubscribe` may
 * still be called after `close`: a subscribe the broker answers late is undone
 * on the link it was made on.
 */
export type BrokerLink = {
  subscribe(topic: string): Promise<boolean>;
  unsubscribe(topic: string): Promise<boolean>;
  publish(topic: string, payload: string): Promise<boolean>;
  /** Stop delivering messages and let go of whatever `open` took. */
  close(): void;
};

export type BrokerTransport = {
  /**
   * What a link to `broker` is tied to. The session keeps one link for as long
   * as this stays the same, and replaces it when it changes. A host that keeps
   * the broker's connection itself ties a link to the broker alone; where the
   * link is the connection, it is tied to the URL and the login as well.
   * Never empty.
   */
  linkKey(broker: MqttBrokerConfig): string;
  /**
   * Start working with `broker` as its settings have settled. `undefined` when
   * this host cannot reach it at all (a `mqtt://` broker from a browser, a URL
   * that is not complete). Never throws.
   *
   * `onMessage` gets what the host receives while the link is open. A host may
   * report more than this link asked for (the desktop host has one message
   * event for every console and every flow node), so an adapter passes on what
   * it gets and the session decides what belongs in its transcript.
   */
  open(broker: MqttBrokerConfig, onMessage: (message: BrokerMessage) => void): BrokerLink | undefined;
};

/* ── the session ────────────────────────────────────────────────────────── */

export type BrokerConsoleSession = ConsoleSession<{
  /** Topic filters the console is subscribed to on the selected broker. */
  subscriptions: string[];
}>;

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

export function createBrokerConsoleSession(options: {
  transport: BrokerTransport;
  /** Where analytics events go. */
  track?: typeof trackEvent;
}): BrokerConsoleSession {
  const { transport, track = trackEvent } = options;
  const brokers = () => useMqttBrokerStore.getState().brokers;

  const transcript = createTranscript({
    selectedId: brokers().find((broker) => broker.isDefault)?.id ?? brokers()[0]?.id ?? "",
    extra: { subscriptions: [] as string[] },
    vocabulary: COMMANDS,
    commands: (state) => {
      // Topics the console has actually touched, newest first — better
      // completions than any list we could guess at.
      const known = () => {
        const seen = state.lines.map((line) => line.label).filter((label): label is string => Boolean(label));
        return [...new Set([...state.subscriptions, ...seen.reverse()])];
      };
      return COMMANDS.map((command) => {
        if (command.name === "unsubscribe") return { ...command, values: () => state.subscriptions };
        if (command.name === "subscribe" || command.name === "publish") return { ...command, values: known };
        return command;
      });
    },
  });

  const selected = () => brokers().find((broker) => broker.id === transcript.getState().selectedId);

  let live = false;
  let link: BrokerLink | undefined;
  /** The transport's key for what `link` was opened for; empty while there is none. */
  let linkedTo = "";
  /**
   * Topic filters asked for and not yet answered. A broker may deliver a
   * retained message before the subscribe call returns, and that message is
   * the console's as much as any later one.
   */
  const awaited: string[] = [];

  /**
   * A message belongs in the transcript only when it is from the selected
   * broker and on a topic this console subscribed to. Everything else the host
   * reports — a flow node's traffic, another broker's — is not this console's.
   */
  const receive = (message: BrokerMessage) => {
    const { selectedId, subscriptions } = transcript.getState();
    if (message.brokerId !== selectedId) return;
    if (![...subscriptions, ...awaited].some((filter) => topicMatches(filter, message.topic))) return;
    transcript.push({ kind: "in", label: message.topic, text: message.payload });
  };

  /**
   * Keep the link on the selected broker as it is configured now. The
   * transport says what a link is tied to, so the link is replaced when that
   * changes and left alone on every other edit.
   */
  const follow = () => {
    const broker = live ? selected() : undefined;
    const target = broker ? transport.linkKey(broker) : "";
    if (target === linkedTo) return;
    link?.close();
    // Recorded before opening: an adapter may write the broker's status to the
    // store while it opens, and that lands back here.
    linkedTo = target;
    link = broker ? transport.open(broker, receive) : undefined;
  };

  /**
   * Unsubscribe everything the console subscribed on the selected broker. The
   * subscriptions are the console's, not the broker's: they end when the
   * console lets go of it.
   */
  const release = () => {
    for (const topic of transcript.getState().subscriptions) void link?.unsubscribe(topic);
    awaited.length = 0;
  };

  const select = (brokerId: string) => {
    if (brokerId === transcript.getState().selectedId) return;
    release();
    transcript.select(brokerId, { subscriptions: [] });
    follow();
  };

  /** A deleted broker cannot stay selected: move to the first one left. */
  const followStore = () => {
    const { selectedId } = transcript.getState();
    if (selectedId !== "" && !selected()) return select(brokers()[0]?.id ?? "");
    follow();
  };

  const subscribe = async (topic: string, reply: Reply) => {
    const asked = link;
    const brokerId = transcript.getState().selectedId;
    awaited.push(topic);
    const success = (await asked?.subscribe(topic)) ?? false;
    if (!reply.current) {
      // The console let go of this broker while the broker was answering, so
      // nothing is left to unsubscribe the topic later: do it now. Unless the
      // console is back on the broker and has asked for the same topic again —
      // a broker holds one subscription per filter, and that one is in use.
      const { selectedId, subscriptions } = transcript.getState();
      const heldAgain = selectedId === brokerId && [...subscriptions, ...awaited].includes(topic);
      if (success && !heldAgain) void asked?.unsubscribe(topic);
      return;
    }
    awaited.splice(awaited.indexOf(topic), 1);
    if (success) {
      transcript.update({ subscriptions: [...new Set([...transcript.getState().subscriptions, topic])] });
    }
    reply.push({
      kind: success ? "sys" : "err",
      label: topic,
      text: success ? "subscribed" : "could not subscribe — is the broker connected?",
    });
  };

  const unsubscribe = async (topic: string, reply: Reply) => {
    const success = (await link?.unsubscribe(topic)) ?? false;
    if (!reply.current) return;
    if (success) {
      transcript.update({
        subscriptions: transcript.getState().subscriptions.filter((entry) => entry !== topic),
      });
    }
    reply.push({
      kind: success ? "sys" : "err",
      label: topic,
      text: success ? "unsubscribed" : "could not unsubscribe",
    });
  };

  const publish = async (topic: string, payload: string, reply: Reply) => {
    const success = (await link?.publish(topic, payload)) ?? false;
    reply.push({
      kind: success ? "out" : "err",
      label: topic,
      text: success ? payload : "could not publish — is the broker connected?",
    });
  };

  return {
    getState: transcript.getState,
    subscribe: transcript.subscribe,

    open() {
      live = true;
      follow();
      const unfollow = useMqttBrokerStore.subscribe(followStore);
      return () => {
        unfollow();
        release();
        transcript.abandon();
        transcript.update({ subscriptions: [] });
        live = false;
        follow();
      };
    },

    select,

    run: (input) => {
      // A command is the user acting on the broker the form shows: what is
      // still being typed there settles now, so the link is to that broker
      // before the command goes out on it.
      settleBrokerSettings();
      return transcript.run(input, (parsed, reply) => {
        const topic = parsed.tokens[0];
        switch (parsed.verb) {
          case "subscribe":
          case "sub":
            if (!topic) {
              return transcript.push({ kind: "err", text: "subscribe needs a topic — try: subscribe test/#" });
            }
            return subscribe(topic, reply);
          case "unsubscribe":
          case "unsub":
            if (!topic) return transcript.push({ kind: "err", text: "unsubscribe needs a topic" });
            return unsubscribe(topic, reply);
          case "publish":
          case "pub":
            if (!topic) {
              return transcript.push({
                kind: "err",
                text: "publish needs a topic — try: publish test/hello world",
              });
            }
            return publish(topic, restAfter(parsed, 1), reply);
          default:
            return transcript.push({
              kind: "err",
              text: `unknown command "${parsed.verb}" — press ? for the list`,
            });
        }
      });
    },

    reportConfigured() {
      // The broker as the form shows it: the field that was just left may not
      // have settled yet.
      const { selectedId } = transcript.getState();
      const broker = brokerSettingsForm(useMqttBrokerStore.getState()).brokers.find(
        (entry) => entry.id === selectedId,
      );
      if (!broker || broker.url.trim() === "") return;
      transcript.reportOnce(broker.id, () =>
        track("mqtt_broker_added", {
          scheme: broker.url.split("://")[0] || "unknown",
          auth: Boolean(broker.username),
        }),
      );
    },
  };
}
