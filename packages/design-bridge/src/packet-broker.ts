/**
 * Test support: a small MQTT 3.1.1 broker on a local WebSocket that logs every
 * packet a client sends. The mqtt.js adapter is tested against it, so those
 * tests see the real wire: the CONNECT with its last will, each SUBSCRIBE, the
 * retain flag and QoS of each PUBLISH.
 *
 * It keeps retained messages, delivers at QoS 0, completes the QoS 1 and 2
 * handshakes, and publishes a client's last will when its socket closes
 * without a DISCONNECT.
 */
import type { ServerWebSocket } from "bun";
import mqttPacket, { type Packet } from "mqtt-packet";
import { topicMatches } from "./topic-filter";

type Will = { topic: string; payload: Uint8Array | string; retain?: boolean; qos?: number };
type Client = { id: string; will: Will | null; filters: Set<string>; goodbye: boolean };
type SocketData = { client: Client; parser: ReturnType<typeof mqttPacket.parser> };
type Socket = ServerWebSocket<SocketData>;

export function startPacketBroker() {
  const sockets = new Set<Socket>();
  const retained = new Map<string, string>();
  const log: Array<{ client: string; packet: string }> = [];

  function deliver(topic: string, payload: string, retain: boolean) {
    if (retain) retained.set(topic, payload);
    for (const socket of sockets) {
      if ([...socket.data.client.filters].some((filter) => topicMatches(filter, topic))) {
        send(socket, { cmd: "publish", topic, payload, qos: 0, retain: false, dup: false });
      }
    }
  }

  function send(socket: Socket, packet: Packet) {
    socket.send(mqttPacket.generate(packet));
  }

  function onPacket(socket: Socket, packet: Packet) {
    const { client } = socket.data;
    const record = (text: string) => log.push({ client: client.id, packet: text });
    switch (packet.cmd) {
      case "connect": {
        client.id = packet.clientId;
        client.will = packet.will ?? null;
        const will = packet.will
          ? ` will=${packet.will.topic}|${packet.will.payload}|${flags(packet.will)}`
          : "";
        const login = packet.username ? ` login=${packet.username}:${packet.password}` : "";
        record(`CONNECT${login}${will}`);
        sockets.add(socket);
        send(socket, { cmd: "connack", returnCode: 0, sessionPresent: false });
        break;
      }
      case "subscribe": {
        const filters = packet.subscriptions.map(({ topic }) => topic);
        record(`SUBSCRIBE ${filters.join(" ")}`);
        for (const filter of filters) client.filters.add(filter);
        send(socket, { cmd: "suback", messageId: packet.messageId, granted: filters.map(() => 0) });
        for (const filter of filters) {
          for (const [topic, payload] of retained) {
            if (!topicMatches(filter, topic)) continue;
            send(socket, { cmd: "publish", topic, payload, qos: 0, retain: true, dup: false });
          }
        }
        break;
      }
      case "unsubscribe":
        record(`UNSUBSCRIBE ${packet.unsubscriptions.join(" ")}`);
        for (const filter of packet.unsubscriptions) client.filters.delete(filter);
        send(socket, { cmd: "unsuback", messageId: packet.messageId, granted: [] });
        break;
      case "publish":
        record(`PUBLISH ${packet.topic} ${packet.payload} ${flags(packet)}`);
        if (packet.qos === 1) send(socket, { cmd: "puback", messageId: packet.messageId });
        if (packet.qos === 2) send(socket, { cmd: "pubrec", messageId: packet.messageId });
        deliver(packet.topic, String(packet.payload), packet.retain);
        break;
      case "pubrel":
        send(socket, { cmd: "pubcomp", messageId: packet.messageId });
        break;
      case "pingreq":
        send(socket, { cmd: "pingresp" });
        break;
      case "disconnect":
        record("DISCONNECT");
        client.goodbye = true;
        break;
    }
  }

  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bun) {
      const client: Client = { id: "", will: null, filters: new Set(), goodbye: false };
      const parser = mqttPacket.parser({ protocolVersion: 4 });
      // Bun answers the `mqtt` subprotocol the client asks for by itself.
      const upgraded = bun.upgrade(request, { data: { client, parser } });
      return upgraded ? undefined : new Response("MQTT over WebSocket only", { status: 400 });
    },
    websocket: {
      open(socket) {
        socket.data.parser.on("packet", (packet) => onPacket(socket, packet));
      },
      message(socket, message) {
        socket.data.parser.parse(Buffer.from(message));
      },
      close(socket) {
        const { client } = socket.data;
        if (!sockets.delete(socket)) return;
        log.push({ client: client.id, packet: "CLOSE" });
        if (!client.goodbye && client.will) {
          deliver(client.will.topic, String(client.will.payload), client.will.retain ?? false);
        }
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}/mqtt`,

    /** What the clients whose ID starts with `clientId` sent, oldest first. */
    packets: (clientId: string) =>
      log.filter(({ client }) => client.startsWith(clientId)).map(({ packet }) => packet),

    retained: (topic: string) => retained.get(topic),

    /** A message from another client. */
    publish: (topic: string, payload: string, options?: { retain?: boolean }) =>
      deliver(topic, payload, options?.retain ?? false),

    /** Cut the sockets of the clients whose ID starts with `clientId`, as a lost network does. */
    drop(clientId: string) {
      for (const socket of sockets) {
        if (socket.data.client.id.startsWith(clientId)) socket.terminate();
      }
    },

    stop: () => server.stop(true),
  };
}

function flags(message: { retain?: boolean; qos?: number }) {
  return `${message.retain ? "retain " : ""}qos${message.qos ?? 0}`;
}

/** Wait until `check` holds. Fails after `timeout` ms, so a broken test does not hang. */
export async function until(check: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
