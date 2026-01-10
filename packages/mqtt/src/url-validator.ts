import { z } from "zod";
import { mqttUrlRegex } from "./constants";

/**
 * Zod schema for validating MQTT URL format
 * Format: [<protocol>://]<host>[:<port>][/<path>]
 * - Protocol is optional (defaults to wss)
 * - Host is required
 * - Port is optional (defaults to 8883)
 * - Path is optional (defaults to /mqtt)
 *
 * Examples:
 * - mqtt.xiduzo.com → wss://mqtt.xiduzo.com:8883/mqtt
 * - mqtt.xiduzo.com:443 → wss://mqtt.xiduzo.com:443/mqtt
 * - mqtt.xiduzo.com/mqtt → wss://mqtt.xiduzo.com:8883/mqtt
 * - mqtt.xiduzo.com:443/mqtt → wss://mqtt.xiduzo.com:443/mqtt
 * - wss://mqtt.xiduzo.com:443/mqtt → wss://mqtt.xiduzo.com:443/mqtt
 */
export const mqttUrlSchema = z
  .string()
  .min(1, "Host is required")
  .superRefine((input, ctx) => {
    console.log("[MQTT URL Validation] Parsing full URL:", input);
    // Check if it's a full URL (starts with ws:// or wss://)
    if (input.startsWith("ws://") || input.startsWith("wss://")) {
      try {
        const urlObj = new URL(input);
        const protocol = urlObj.protocol.replace(":", "") as "ws" | "wss";

        if (protocol !== "ws" && protocol !== "wss") {
          ctx.addIssue({
            code: "custom",
            message: `Invalid protocol: ${protocol}. Must be 'ws' or 'wss'`,
          });
          return;
        }

        const host = urlObj.hostname;
        if (!host || host.length === 0) {
          ctx.addIssue({
            code: "custom",
            message: "Host is required",
          });
          return;
        }

        // Validate port if provided
        if (urlObj.port) {
          const port = parseInt(urlObj.port, 10);
          if (Number.isNaN(port) || port < 1 || port > 65535) {
            ctx.addIssue({
              code: "custom",
              message: `Invalid port: ${urlObj.port}. Must be between 1 and 65535`,
            });
            return;
          }
        }
      } catch (error) {
        console.error("[MQTT URL Validation] Error parsing URL:", input, error);
        ctx.addIssue({
          code: "custom",
          message: `Invalid URL format. Expected: [ws://|wss://]<host>[:<port>][/<path>]. Error: ${
            error instanceof Error ? error.message : "Unable to parse URL"
          }`,
        });
      }
    } else {
      // It's a host with optional port and path - validate format
      // Format: host[:port][/path]
      if (/\s/.test(input)) {
        ctx.addIssue({
          code: "custom",
          message: "Host cannot contain spaces",
        });
        return;
      }

      // Parse host:port/path manually
      // Host cannot contain colons or slashes
      const portMatch = input.match(/^([^:/]+)(?::(\d+))?(?:\/(.*))?$/);
      if (!portMatch) {
        ctx.addIssue({
          code: "custom",
          message: "Invalid hostname format",
        });
        return;
      }

      const host = portMatch[1];
      const portStr = portMatch[2];

      // Validate host
      if (!host || host.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "Host is required",
        });
        return;
      }

      // Check for basic hostname validity (contains at least one dot or is localhost)
      if (host !== "localhost" && !host.includes(".")) {
        ctx.addIssue({
          code: "custom",
          message: "Invalid hostname format",
        });
        return;
      }

      // Validate port if provided
      if (portStr) {
        const port = parseInt(portStr, 10);
        if (Number.isNaN(port) || port < 1 || port > 65535) {
          ctx.addIssue({
            code: "custom",
            message: `Invalid port: ${portStr}. Must be between 1 and 65535`,
          });
          return;
        }
      }
    }
  });
