/**
 * The test adapter at the broker seam: a broker in memory, with the behaviour
 * the bridge relies on. Retained messages reach a new subscription, a last will
 * is published when a connection is lost, and wildcards match per level.
 *
 * The broker handles what a client sends in the order the client sent it, as a
 * real broker does on one connection: a subscription's retained messages are
 * delivered before the echo of anything the client published after subscribing.
 * A connection comes up one microtask after `connect`.
 */
import type { BridgeMqtt } from "./bridge";
import type { BrokerConnectOptions, BrokerConnector, BrokerMessage } from "./broker";
import { topicMatches } from "./topic-filter";

type Listener = (topic: string, payload: string) => void;
type Subscription = { filter: string; onMessage: Listener; online: () => boolean };

/** A party without a last will that is always connected: the engine alone, or Studio in a test. */
export type MemoryClient = BridgeMqtt & {
  /** What this client published, oldest first. */
  sent: BrokerMessage[];
  /** What this client received on its subscriptions, oldest first. */
  received: Array<{ topic: string; payload: string }>;
};

/** A connection opened through the connector, as the broker sees it. */
export type MemoryConnection = Omit<BrokerConnectOptions, "onStatus"> & { online: boolean };

export function createMemoryBroker() {
  const subscriptions = new Set<Subscription>();
  const retained = new Map<string, string>();
  const published: BrokerMessage[] = [];
  const links = new Set<Link>();
  const heldWills: BrokerMessage[] = [];
  let holdWills = false;

  type Link = {
    info: MemoryConnection;
    own: Set<Subscription>;
    dropped: boolean;
    onStatus: BrokerConnectOptions["onStatus"];
  };

  /** Deliveries wait here, so a client is never called back in the middle of its own call. */
  const outbox: Array<() => void> = [];
  let delivering = false;
  let paused = 0;

  function flush() {
    if (delivering || paused > 0) return;
    delivering = true;
    try {
      for (let next = outbox.shift(); next; next = outbox.shift()) next();
    } finally {
      delivering = false;
    }
  }

  function send(subscription: Subscription, topic: string, payload: string) {
    outbox.push(() => {
      if (subscriptions.has(subscription) && subscription.online()) {
        subscription.onMessage(topic, payload);
      }
    });
  }

  /** The broker takes a message: it keeps a retained one and sends it to who is subscribed now. */
  function accept(message: BrokerMessage) {
    published.push(message);
    if (message.retain) retained.set(message.topic, message.payload);
    for (const subscription of subscriptions) {
      if (subscription.online() && topicMatches(subscription.filter, message.topic)) {
        send(subscription, message.topic, message.payload);
      }
    }
    flush();
  }

  function sendRetained(subscription: Subscription) {
    for (const [topic, payload] of retained) {
      if (topicMatches(subscription.filter, topic)) send(subscription, topic, payload);
    }
  }

  function publishWill(will: BrokerMessage) {
    if (holdWills) heldWills.push(will);
    else accept(will);
  }

  /** The connection is accepted: the client subscribes again, then learns that it is connected. */
  function bringUp(link: Link) {
    link.info.online = true;
    paused++;
    for (const subscription of link.own) sendRetained(subscription);
    link.onStatus("connected");
    paused--;
    flush();
  }

  const connector: BrokerConnector = ({ onStatus, ...options }) => {
    const link: Link = { info: { ...options, online: false }, own: new Set(), dropped: false, onStatus };
    let ended = false;
    links.add(link);
    queueMicrotask(() => {
      if (!ended) bringUp(link);
    });

    return {
      publish(topic, payload, publishOptions) {
        if (!link.info.online) return;
        accept({
          topic,
          payload,
          retain: publishOptions?.retain ?? false,
          qos: publishOptions?.qos ?? 0,
        });
      },
      subscribe(filter, onMessage) {
        const subscription = { filter, onMessage, online: () => link.info.online };
        subscriptions.add(subscription);
        link.own.add(subscription);
        if (link.info.online) {
          sendRetained(subscription);
          flush();
        }
        return () => {
          subscriptions.delete(subscription);
          link.own.delete(subscription);
        };
      },
      end() {
        if (ended) return;
        ended = true;
        links.delete(link);
        for (const subscription of link.own) subscriptions.delete(subscription);
        const wasOnline = link.info.online;
        link.info.online = false;
        if (wasOnline) publishWill(link.info.will);
      },
    };
  };

  return {
    connector,

    /** The connections that are open (up or retrying), oldest first. */
    connections: (): MemoryConnection[] => [...links].map((link) => link.info),

    /** Every message the broker took, last wills included, oldest first, as it was published. */
    published,

    retained: (topic: string) => retained.get(topic),

    subscriptionCount: () => subscriptions.size,

    client(): MemoryClient {
      const sent: BrokerMessage[] = [];
      const received: MemoryClient["received"] = [];
      return {
        sent,
        received,
        publish(topic, payload, options) {
          const message = {
            topic,
            payload,
            retain: options?.retain ?? false,
            qos: options?.qos ?? 0,
          };
          sent.push(message);
          accept(message);
        },
        subscribe(filter, onMessage) {
          const subscription: Subscription = {
            filter,
            onMessage: (topic, payload) => {
              received.push({ topic, payload });
              onMessage(topic, payload);
            },
            online: () => true,
          };
          subscriptions.add(subscription);
          sendRetained(subscription);
          flush();
          return () => subscriptions.delete(subscription);
        },
      };
    },

    /** The network drops: every connection goes down and its last will is published. */
    dropConnections() {
      for (const link of links) {
        if (!link.info.online) continue;
        link.info.online = false;
        link.dropped = true;
        publishWill(link.info.will);
        link.onStatus("disconnected");
      }
    },

    /** The network is back: every connection that was down retries and comes up. */
    restoreConnections() {
      for (const link of links) {
        if (!link.dropped) continue;
        link.dropped = false;
        link.onStatus("connecting");
        bringUp(link);
      }
    },

    /** From now on the broker notices a lost connection late: its will waits for `releaseWills`. */
    holdWills() {
      holdWills = true;
    },

    releaseWills() {
      holdWills = false;
      for (const will of heldWills.splice(0)) accept(will);
    },
  };
}

export type MemoryBroker = ReturnType<typeof createMemoryBroker>;
