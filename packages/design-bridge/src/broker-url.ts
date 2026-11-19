/**
 * The broker URL a plugin user types: `[ws://|wss://]host[:port][/path]`.
 * This module is the one place that knows the grammar; the settings form shows
 * its error and the broker connection uses its result.
 *
 * Defaults: protocol `wss`, port 8883 (`wss`) or 1883 (`ws`), path `/mqtt`.
 * `mqtt.example.com` is `wss://mqtt.example.com:8883/mqtt`.
 */

export type BrokerUrl = {
  protocol: "ws" | "wss";
  host: string;
  port: number;
  path: string;
};

export type BrokerUrlResult = { ok: true; url: BrokerUrl } | { ok: false; error: string };

/** The plugins' default broker: the public test.mosquitto.org WebSocket listener. */
export const DEFAULT_BROKER_URL = "wss://test.mosquitto.org:8081/mqtt";

const GRAMMAR = /^(?:(wss?):\/\/)?([^\s/:]+)(?::(\d+))?(?:\/(.*))?$/;
const EXPECTED = "Invalid URL. Expected [ws://|wss://]host[:port][/path]";

export function parseBrokerUrl(input: string): BrokerUrlResult {
  if (input.length === 0) return invalid("Host is required");
  const hasProtocol = /^wss?:\/\//.test(input);
  if (!hasProtocol && /\s/.test(input)) return invalid("Host cannot contain spaces");

  const match = GRAMMAR.exec(input);
  const host = match?.[2];
  if (!match || !host) return invalid(hasProtocol ? EXPECTED : "Invalid hostname format");
  const protocol = match[1] === "ws" ? "ws" : "wss";

  const port = match[3] === undefined ? (protocol === "wss" ? 8883 : 1883) : Number(match[3]);
  if (port < 1 || port > 65535) {
    return invalid(`Invalid port: ${match[3]}. Must be between 1 and 65535`);
  }

  // A bare host must look like one; a full URL must be one the browser accepts.
  if (hasProtocol ? !isUrl(input) : host !== "localhost" && !host.includes(".")) {
    return invalid(hasProtocol ? EXPECTED : "Invalid hostname format");
  }

  const rest = match[4];
  const path = rest ? (rest.startsWith("/") ? rest : `/${rest}`) : "/mqtt";
  return { ok: true, url: { protocol, host, port, path } };
}

function invalid(error: string): BrokerUrlResult {
  return { ok: false, error };
}

function isUrl(input: string): boolean {
  try {
    new URL(input);
    return true;
  } catch {
    return false;
  }
}
