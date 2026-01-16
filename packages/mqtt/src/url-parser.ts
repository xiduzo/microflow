import { mqttUrlSchema } from "./url-validator";
import { mqttUrlRegex } from "./constants";

export type ParsedMqttUrl = {
  protocol: "ws" | "wss";
  host: string;
  port: number;
  path: string;
};

/**
 * Parses an MQTT URL string into connection options
 * Format: [<protocol>://]<host>[:<port>][/<path>]
 *
 * Defaults:
 * - Protocol: wss
 * - Port: 8883
 * - Path: /mqtt
 *
 * Examples:
 * - mqtt.xiduzo.com → wss://mqtt.xiduzo.com:8883/mqtt
 * - mqtt.xiduzo.com:443 → wss://mqtt.xiduzo.com:443/mqtt
 * - mqtt.xiduzo.com/mqtt → wss://mqtt.xiduzo.com:8883/mqtt
 * - mqtt.xiduzo.com:443/mqtt → wss://mqtt.xiduzo.com:443/mqtt
 * - wss://mqtt.xiduzo.com:443/mqtt → wss://mqtt.xiduzo.com:443/mqtt
 *
 * Note: This function assumes the input has already been validated by mqttUrlSchema
 */
export function parseMqttUrl(input: string): ParsedMqttUrl {
  try {
    const validatedInput = mqttUrlSchema.parse(input);
    const match = validatedInput.match(mqttUrlRegex);
    if (!match || !match[2]) {
      throw new Error(
        `Invalid MQTT URL format: ${input}. Could not parse host.`
      );
    }
    const [, protocol, host, port, path] = match;

    return {
      protocol: (protocol ?? "wss") as "ws" | "wss",
      host,
      port: port
        ? parseInt(String(port), 10)
        : (protocol ?? "wss") === "wss"
        ? 8883
        : 1883,
      path: path ? (path.startsWith("/") ? path : `/${path}`) : "/mqtt",
    };
  } catch (error) {
    throw new Error(
      `Invalid MQTT URL format: ${input}. Expected format: [<protocol>://]<host>[:<port>][/<path>]`
    );
  }
}
